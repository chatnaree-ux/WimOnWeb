// เทียบสิทธิ์เดิมกับ WEB_WIM ใน CoreCenter — อ่านอย่างเดียว ไม่เขียนฐานข้อมูล
//   node tools/perm-migration/compare-perms.js preview  → ก่อนคัดลอก: เช็ครายการเมนูและจำนวนแถวที่จะเกิด
//   node tools/perm-migration/compare-perms.js compare  → หลังคัดลอก: เทียบสิทธิ์รายคน (ไม่ตรง = exit 1)
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const sql = require(path.join(ROOT, 'node_modules/mssql'));

// รายการเมนูอยู่ที่ 02_copy_to_core.sql ที่เดียว
function readMenuMap() {
  const text = fs.readFileSync(path.join(__dirname, '02_copy_to_core.sql'), 'utf8');
  const map = {};
  for (const m of text.matchAll(/\('(WM[A-Za-z]+\d{3})',\s*'(\w+)'\)/g)) map[m[2]] = m[1];
  return map;
}

// สิทธิ์จริงตาม getUserAccess เดิม: เมนูที่ยังใช้งาน ไม่นับ On process และบริษัทที่ยังใช้งาน
async function readOld(pool) {
  const members = (await pool.request().query(`
    SELECT m.idPs, g.idGroup, g.GroupName, ISNULL(CAST(g.stSystem AS int), 0) AS stSystem
    FROM WIMWebUserGroupMember m JOIN WIMWebUserGroup g ON g.idGroup = m.idGroup
    WHERE m.stDel IS NULL AND g.stDel IS NULL`)).recordset;
  const menus = (await pool.request().query(`
    SELECT p.idGroup, m.MenuCode FROM WIMWebMenuPermission p JOIN WIMWebMenu m ON m.idMenu = p.idMenu
    WHERE p.stAllow = 1 AND p.stDel IS NULL AND m.stDel IS NULL AND ISNULL(m.stWip, 0) = 0`)).recordset;
  const comps = (await pool.request().query(`
    SELECT p.idGroup, p.idComp FROM WIMWebGroupCompPer p JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = p.idComp
    WHERE p.stAllow = 1 AND p.stDel IS NULL AND c.stDel IS NULL AND c.CompName IS NOT NULL`)).recordset;
  const people = {};
  for (const x of members) {
    const isSys = x.stSystem === 1;
    people[x.idPs] = {
      group: x.GroupName,
      unrestricted: isSys,
      menus: isSys ? [] : menus.filter(r => r.idGroup === x.idGroup).map(r => r.MenuCode).sort(),
      comps: isSys ? [] : comps.filter(r => r.idGroup === x.idGroup).map(r => r.idComp).sort((a, b) => a - b)
    };
  }
  return people;
}

async function readCore(pool, menuMap) {
  const appByCore = Object.fromEntries(Object.entries(menuMap).map(([app, core]) => [core, app]));
  const members = (await pool.request().query(`
    SELECT p.idPs, u.idUser, u.UserName, ISNULL(CAST(s.stSystem AS int), 0) AS stSystem
    FROM CoreCenter.dbo.MenuUserPs p
    JOIN CoreCenter.dbo.MenuUser u ON u.idUser = p.idUser AND u.MenuSys = 'WEB_WIM'
    LEFT JOIN WIMWebGroupSet s ON s.idUser = u.idUser`)).recordset;
  const menus = (await pool.request().query(`
    SELECT s.idUser, s.MenuCode
    FROM CoreCenter.dbo.MenuUserSet s
    JOIN CoreCenter.dbo.MenuUser u ON u.idUser = s.idUser AND u.MenuSys = 'WEB_WIM'
    JOIN WIMWebMenu w ON w.CoreMenuCode = s.MenuCode AND w.stDel IS NULL AND ISNULL(w.stWip, 0) = 0`)).recordset;
  const comps = (await pool.request().query(`
    SELECT c.idUser, c.idPs, c.idComp
    FROM CoreCenter.dbo.MenuUserPsComp c
    JOIN CoreCenter.dbo.MenuUser u ON u.idUser = c.idUser AND u.MenuSys = 'WEB_WIM'
    JOIN PchInvAndProject.dbo.dCompany d ON d.idComp = c.idComp AND d.stDel IS NULL AND d.CompName IS NOT NULL`)).recordset;
  const people = {};
  for (const x of members) {
    const p = people[x.idPs] || (people[x.idPs] = { groups: [], unrestricted: false, menus: new Set(), comps: new Set() });
    p.groups.push(x.UserName);
    if (x.stSystem === 1) p.unrestricted = true;
    menus.filter(r => r.idUser === x.idUser).forEach(r => p.menus.add(appByCore[r.MenuCode] || r.MenuCode));
    comps.filter(r => r.idUser === x.idUser && r.idPs === x.idPs).forEach(r => p.comps.add(r.idComp));
  }
  for (const p of Object.values(people)) {
    p.group = p.groups.join(', ');
    p.menus = p.unrestricted ? [] : [...p.menus].sort();
    p.comps = p.unrestricted ? [] : [...p.comps].sort((a, b) => a - b);
  }
  return people;
}

async function preview(pool) {
  const map = readMenuMap();
  const leaves = (await pool.request().query(`
    SELECT w.MenuCode FROM WIMWebMenu w
    WHERE w.stDel IS NULL AND NOT EXISTS (SELECT 1 FROM WIMWebMenu c WHERE c.idParentMenu = w.idMenu AND c.stDel IS NULL)`)).recordset.map(r => r.MenuCode);
  const unmapped = leaves.filter(c => !map[c]);
  const unknown = Object.keys(map).filter(c => !leaves.includes(c));
  const dupCodes = (await pool.request().query(`SELECT MenuCode FROM WIMWebMenu WHERE stDel IS NULL GROUP BY MenuCode HAVING COUNT(*) > 1`)).recordset;
  const multi = (await pool.request().query(`SELECT idPs FROM WIMWebUserGroupMember WHERE stDel IS NULL GROUP BY idPs HAVING COUNT(*) > 1`)).recordset;
  const taken = (await pool.request().query(`
    SELECT (SELECT COUNT(*) FROM CoreCenter.dbo.dSystem WHERE SysName = 'WEB_WIM') AS sys,
           (SELECT COUNT(*) FROM CoreCenter.dbo.MenuData WHERE MenuSys = 'WEB_WIM' OR MenuCode LIKE 'WM%') AS menu,
           (SELECT COUNT(*) FROM CoreCenter.dbo.dSystemMenuGroup WHERE SysName = 'WEB_WIM' OR MenuGroupCode LIKE 'WM%') AS grp,
           (SELECT COUNT(*) FROM CoreCenter.dbo.MenuUser WHERE MenuSys = 'WEB_WIM') AS usr`)).recordset[0];
  const counts = (await pool.request().query(`
    SELECT (SELECT COUNT(*) FROM WIMWebUserGroup WHERE stDel IS NULL) AS UserGroups,
           (SELECT COUNT(*) FROM WIMWebUserGroupMember m JOIN WIMWebUserGroup g ON g.idGroup = m.idGroup WHERE m.stDel IS NULL AND g.stDel IS NULL) AS Members,
           (SELECT COUNT(*) FROM WIMWebMenuPermission p JOIN WIMWebMenu w ON w.idMenu = p.idMenu JOIN WIMWebUserGroup g ON g.idGroup = p.idGroup
             WHERE p.stAllow = 1 AND p.stDel IS NULL AND w.stDel IS NULL AND g.stDel IS NULL) AS MenuPerms,
           (SELECT COUNT(*) FROM (SELECT DISTINCT m.idGroup, m.idPs, p.idComp
              FROM WIMWebGroupCompPer p
              JOIN WIMWebUserGroupMember m ON m.idGroup = p.idGroup AND m.stDel IS NULL
              JOIN WIMWebUserGroup g ON g.idGroup = p.idGroup AND g.stDel IS NULL
              JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = p.idComp AND c.stDel IS NULL AND c.CompName IS NOT NULL
              WHERE p.stAllow = 1 AND p.stDel IS NULL) x) AS CompPerms`)).recordset[0];
  console.log('Menus in map:', Object.keys(map).length, '| active permission menus:', leaves.length);
  console.log('Without core code:', unmapped.join(', ') || 'none');
  console.log('In map but not active:', unknown.join(', ') || 'none');
  console.log('Duplicate app codes:', dupCodes.length, '| people in >1 group:', multi.length);
  console.log('Already in CoreCenter:', JSON.stringify(taken));
  console.log('Will copy:', JSON.stringify(counts));
  return unmapped.length || unknown.length || dupCodes.length || multi.length || taken.sys || taken.menu || taken.grp || taken.usr ? 1 : 0;
}

async function compare(pool) {
  const oldP = await readOld(pool), coreP = await readCore(pool, readMenuMap());
  const ids = [...new Set([...Object.keys(oldP), ...Object.keys(coreP)])];
  let bad = 0;
  for (const id of ids) {
    const a = oldP[id], b = coreP[id], problems = [];
    if (!a) problems.push('only in CoreCenter');
    else if (!b) problems.push('only in old tables');
    else {
      if (a.group !== b.group) problems.push(`group: ${a.group} <> ${b.group}`);
      if (a.unrestricted !== b.unrestricted) problems.push(`full access: ${a.unrestricted} <> ${b.unrestricted}`);
      if (a.menus.join() !== b.menus.join()) problems.push(`menus: ${a.menus.filter(x => !b.menus.includes(x)).join() || '-'} missing, ${b.menus.filter(x => !a.menus.includes(x)).join() || '-'} extra`);
      if (a.comps.join() !== b.comps.join()) problems.push(`companies: ${a.comps.filter(x => !b.comps.includes(x)).join() || '-'} missing, ${b.comps.filter(x => !a.comps.includes(x)).join() || '-'} extra`);
    }
    if (problems.length) { bad++; console.log(`idPs ${id}: ${problems.join(' | ')}`); }
  }
  console.log(`Compared ${ids.length} people: ${ids.length - bad} match, ${bad} differ`);
  return bad ? 1 : 0;
}

(async () => {
  const mode = process.argv[2];
  if (mode !== 'preview' && mode !== 'compare') {
    console.error('Usage: node compare-perms.js preview|compare');
    process.exit(2);
  }
  const pool = await sql.connect({
    server: process.env.DB_SERVER, database: process.env.DB_DATABASE, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, port: parseInt(process.env.DB_PORT || '1433', 10),
    options: { encrypt: process.env.DB_ENCRYPT === 'true', trustServerCertificate: true }
  });
  const code = mode === 'preview' ? await preview(pool) : await compare(pool);
  await pool.close();
  process.exit(code);
})().catch(e => { console.error(e.message); process.exit(1); });
