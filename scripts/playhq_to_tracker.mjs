// playhq_to_tracker.mjs
//
// Converts the PlayHQ season dump (playhq_season_<id>.json, produced by
// playhq_scrape.mjs) into an .xlsx in the stats tracker's export format,
// ready to feed into "Restore from backup".
//
// Writes four sheets: Games, Player Game Log, Fixtures, Byes.
// It deliberately does NOT write PlayerAliases / KnownClubs /
// TeamClubOverrides / ClubNicknames / DismissedMatches - missing sheets are
// tolerated by the importer, and restoring with MERGE leaves your existing
// lookup tables untouched. Players and Teams are omitted too; the app
// recomputes those from Games + Player Game Log.
//
// No dependencies. Requires Node 18+. Run with:
//   node playhq_to_tracker.mjs
//
// USE THE "MERGE" OPTION when restoring, not "Replace everything".

import fs from "fs";
import path from "path";
import zlib from "zlib";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const INPUT_FILE = "playhq_season_cfa23107.json";
const OUTPUT_FILE = "playhq_tracker_import.xlsx";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// "2026-04-25" + "10:00:00" -> "10:00 AM, Saturday, 25 Apr 2026"
function formatDateTime(dateStr, timeStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAYS[dt.getUTCDay()];
  const datePart = `${weekday}, ${pad2(d)} ${MONTHS[m - 1]} ${y}`;
  const timePart = formatTime(timeStr);
  return timePart ? `${timePart}, ${datePart}` : datePart;
}

// "2026-04-25" -> "Saturday, 25 Apr 2026"
function formatDateOnly(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${pad2(d)} ${MONTHS[m - 1]} ${y}`;
}

// "08:15:00" -> "08:15 AM"
function formatTime(timeStr) {
  if (!timeStr) return "";
  const [hRaw, min] = timeStr.split(":").map(Number);
  const ampm = hRaw >= 12 ? "PM" : "AM";
  let h = hRaw % 12;
  if (h === 0) h = 12;
  return `${pad2(h)}:${pad2(min)} ${ampm}`;
}

// Pull a count out of a PlayHQ statistics array, trying several enum names.
function statVal(stats, names) {
  if (!Array.isArray(stats)) return null;
  for (const name of names) {
    const hit = stats.find((s) => s?.type?.value === name);
    if (hit && typeof hit.count === "number") return hit.count;
  }
  return null;
}

const GOAL_KEYS = ["TOTAL_GOALS", "GOALS", "GOAL", "6_POINT_SCORE"];
const BEHIND_KEYS = ["TOTAL_BEHINDS", "BEHINDS", "BEHIND", "1_POINT_SCORE"];
const SCORE_KEYS = ["TOTAL_SCORE", "SCORE", "POINTS"];

// result.<side> -> cumulative quarter scores, e.g. [26, 43, 57, 85]
function cumulativeQuarters(sideResult) {
  const order = ["FIRST_QTR", "SECOND_QTR", "THIRD_QTR", "FOURTH_QTR"];
  const periods = sideResult?.periods;
  if (!Array.isArray(periods) || periods.length === 0) return ["", "", "", ""];
  let running = 0;
  return order.map((value) => {
    const p = periods.find((x) => x?.period?.value === value);
    const inc = p ? statVal(p.statistics, SCORE_KEYS) : null;
    if (typeof inc === "number") running += inc;
    return running;
  });
}

function outcomeLetter(sideResult) {
  const v = sideResult?.outcome?.value || "";
  if (v.startsWith("W")) return "W";
  if (v.startsWith("L")) return "L";
  if (v.startsWith("D") || v.startsWith("T")) return "D";
  return "";
}

// "12.13" style goals.behinds ratio
function ratio(sideResult) {
  const g = statVal(sideResult?.statistics, GOAL_KEYS);
  const b = statVal(sideResult?.statistics, BEHIND_KEYS);
  if (g == null && b == null) return "";
  return `${g ?? 0}.${b ?? 0}`;
}

function sideScore(sideResult) {
  if (typeof sideResult?.score === "number") return sideResult.score;
  const s = statVal(sideResult?.statistics, SCORE_KEYS);
  return s == null ? "" : s;
}

// Player display name from either a profile or an anonymous/fill-in record.
function playerName(entry) {
  const p = entry?.player || {};
  if (p.profile) {
    return `${p.profile.firstName || ""} ${p.profile.lastName || ""}`.trim();
  }
  return p.name || "";
}

function bestPlayerName(bp) {
  const p = bp?.participant || {};
  if (p.profile) {
    return `${p.profile.firstName || ""} ${p.profile.lastName || ""}`.trim();
  }
  return p.name || "";
}

function sortedBestPlayers(teamStats) {
  const list = Array.isArray(teamStats?.bestPlayers) ? teamStats.bestPlayers : [];
  return [...list]
    .sort((a, b) => (a.ranking ?? 99) - (b.ranking ?? 99))
    .map((bp) => ({
      name: bestPlayerName(bp),
      id: bp?.participant?.id || null,
      ranking: bp.ranking,
    }))
    .filter((x) => x.name);
}

// Grading / Finals / Regular Season, matching the app's own derivation.
function derivePhase(gradeName, roundLabel) {
  const comp = gradeName || "";
  if (/final/i.test(roundLabel || "") || /final/i.test(comp)) return "Finals";
  if (/grading/i.test(comp)) return "Grading";
  return "Regular Season";
}

function roundLabelFor(round) {
  if (round.isFinalsRound && round.abbreviatedName) return round.abbreviatedName;
  if (round.roundNumber != null) return `Round ${round.roundNumber}`;
  return round.abbreviatedName || "";
}

function venueLabel(game) {
  const v = game.venue || "";
  const c = game.court || "";
  if (v && c) return `${v} / ${c}`;
  return v || c || "";
}

// ---------------------------------------------------------------------------
// Minimal .xlsx writer (no dependencies)
// ---------------------------------------------------------------------------

function colName(n) {
  let s = "";
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // strip control chars Excel rejects
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function cellXml(ref, value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    value
  )}</t></is></c>`;
}

function sheetXml(rows) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    "<sheetData>",
  ];
  rows.forEach((row, r) => {
    const cells = row
      .map((val, c) => cellXml(`${colName(c)}${r + 1}`, val))
      .join("");
    parts.push(`<row r="${r + 1}">${cells}</row>`);
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

// --- tiny ZIP writer (deflate) ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function writeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

function buildWorkbook(sheets) {
  const files = [];

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join(""),
    "</Types>",
  ].join("");
  files.push({ name: "[Content_Types].xml", data: contentTypes });

  files.push({
    name: "_rels/.rels",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  });

  const sheetTags = sheets
    .map(
      (s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join("");
  files.push({
    name: "xl/workbook.xml",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheetTags}</sheets></workbook>`,
  });

  const rels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join("");
  files.push({
    name: "xl/_rels/workbook.xml.rels",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>",
  });

  files.push({
    name: "xl/styles.xml",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>",
  });

  sheets.forEach((s, i) => {
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(s.rows),
    });
  });

  return writeZip(files);
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

const GAMES_HEADER = [
  "GameId","Date","Venue","TeamA","TeamAScore","TeamAResult","TeamARatio",
  "TeamB","TeamBScore","TeamBResult","TeamBRatio","Margin","Result",
  "TeamABestPlayers","TeamBBestPlayers",
  "TeamAQ1","TeamAQ2","TeamAQ3","TeamAQ4",
  "TeamBQ1","TeamBQ2","TeamBQ3","TeamBQ4",
  "Phase","CompetitionRaw","RoundLabel","Year",
  "BestPlayersMissing","PlayerStatsMissing","IsForfeit","IsAbandoned",
];

const LOG_HEADER = [
  "GameId","Date","Team","Opponent","Result","Number","Player","Tag",
  "Goals","BestPlayerRank",
];

const FIXTURES_HEADER = [
  "FixtureId","RoundLabel","CompetitionRaw","Year","Date","Time","Venue",
  "TeamA","TeamB","IsBye",
];

const BYES_HEADER = ["Team","RoundLabel","DateTime","Year","Phase"];

function buildPlayerRows(gameId, dateLabel, teamStats, teamName, oppName, resultLetter) {
  const rows = [];
  const players = Array.isArray(teamStats?.players) ? teamStats.players : [];
  const best = sortedBestPlayers(teamStats);

  const rankById = new Map();
  const rankByName = new Map();
  best.forEach((b, idx) => {
    const rank = b.ranking ?? idx + 1;
    if (b.id) rankById.set(b.id, rank);
    rankByName.set(b.name.toLowerCase(), rank);
  });

  for (const entry of players) {
    const name = playerName(entry);
    if (!name) continue;
    const id = entry?.player?.id || null;
    const rank =
      (id && rankById.get(id)) || rankByName.get(name.toLowerCase()) || "";
    rows.push([
      gameId,
      dateLabel,
      teamName,
      oppName,
      resultLetter,
      entry.playerNumber == null ? "" : String(entry.playerNumber),
      name,
      entry?.captain?.shortName || "",
      statVal(entry.statistics, GOAL_KEYS) ?? 0,
      rank,
    ]);
  }
  return rows;
}

function main() {
  const inPath = path.resolve(INPUT_FILE);
  if (!fs.existsSync(inPath)) {
    console.error(`Can't find ${INPUT_FILE} in this folder.`);
    process.exit(1);
  }

  console.log(`Reading ${INPUT_FILE}...`);
  const season = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const year = Number(season.seasonName) || new Date().getFullYear();

  const gameRows = [GAMES_HEADER];
  const logRows = [LOG_HEADER];
  const fixtureRows = [FIXTURES_HEADER];
  const byeRows = [BYES_HEADER];

  let played = 0;
  let upcoming = 0;
  let withStats = 0;

  for (const grade of season.grades || []) {
    const competitionRaw = grade.gradeName || "";

    for (const round of grade.rounds || []) {
      const roundLabel = roundLabelFor(round);
      const phase = derivePhase(competitionRaw, roundLabel);
      const games = round.games || [];

      // Byes: borrow the round's date from its first scheduled game.
      const firstDated = games.find((g) => g.date);
      const byeDateTime = firstDated
        ? formatDateTime(firstDated.date, firstDated.time)
        : "";
      for (const bye of round.byes || []) {
        byeRows.push([bye.teamName || "", roundLabel, byeDateTime, year, phase]);
      }

      for (const game of games) {
        const status = game.status || "";
        const dateLabel = formatDateTime(game.date, game.time);
        const venue = venueLabel(game);
        const teamA = game.home?.teamName || "";
        const teamB = game.away?.teamName || "";

        if (status === "UPCOMING") {
          upcoming++;
          fixtureRows.push([
            game.gameId,
            roundLabel,
            competitionRaw,
            year,
            formatDateOnly(game.date),
            formatTime(game.time),
            venue,
            teamA,
            teamB,
            false,
          ]);
          continue;
        }

        played++;

        // Prefer the richer gameView result when present, else the fixture one.
        const fullResult = game.fullStats?.result || null;
        const res = fullResult || game.result || {};
        const homeRes = res.home || {};
        const awayRes = res.away || {};

        const scoreA = sideScore(homeRes);
        const scoreB = sideScore(awayRes);
        const margin =
          typeof scoreA === "number" && typeof scoreB === "number"
            ? Math.abs(scoreA - scoreB)
            : "";

        const qA = cumulativeQuarters(homeRes);
        const qB = cumulativeQuarters(awayRes);

        const statsHome = game.fullStats?.statistics?.home || null;
        const statsAway = game.fullStats?.statistics?.away || null;

        const bestA = sortedBestPlayers(statsHome).map((b) => b.name);
        const bestB = sortedBestPlayers(statsAway).map((b) => b.name);

        const playersA = statsHome?.players?.length || 0;
        const playersB = statsAway?.players?.length || 0;
        if (playersA || playersB) withStats++;

        const resultText =
          homeRes.gameOutcomeDescription ||
          awayRes.gameOutcomeDescription ||
          "";

        gameRows.push([
          game.gameId,
          dateLabel,
          venue,
          teamA,
          scoreA,
          outcomeLetter(homeRes),
          ratio(homeRes),
          teamB,
          scoreB,
          outcomeLetter(awayRes),
          ratio(awayRes),
          margin,
          resultText,
          bestA.join(", "),
          bestB.join(", "),
          qA[0], qA[1], qA[2], qA[3],
          qB[0], qB[1], qB[2], qB[3],
          phase,
          competitionRaw,
          roundLabel,
          year,
          bestA.length === 0 && bestB.length === 0,
          playersA === 0 && playersB === 0,
          /forfeit/i.test(status) || /forfeit/i.test(resultText),
          /abandon/i.test(status),
        ]);

        const letterA = outcomeLetter(homeRes);
        const letterB = outcomeLetter(awayRes);
        logRows.push(
          ...buildPlayerRows(game.gameId, dateLabel, statsHome, teamA, teamB, letterA)
        );
        logRows.push(
          ...buildPlayerRows(game.gameId, dateLabel, statsAway, teamB, teamA, letterB)
        );
      }
    }
  }

  console.log(`  played games:    ${played} (${withStats} with player stats)`);
  console.log(`  upcoming games:  ${upcoming}`);
  console.log(`  player log rows: ${logRows.length - 1}`);
  console.log(`  byes:            ${byeRows.length - 1}`);

  const buf = buildWorkbook([
    { name: "Games", rows: gameRows },
    { name: "Player Game Log", rows: logRows },
    { name: "Fixtures", rows: fixtureRows },
    { name: "Byes", rows: byeRows },
  ]);

  fs.writeFileSync(OUTPUT_FILE, buf);
  console.log(
    `\nWrote ${OUTPUT_FILE} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`
  );
  console.log("Restore it with the MERGE option, not Replace everything.");
}

main();
