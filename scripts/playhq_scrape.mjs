// playhq_scrape.mjs
//
// Pulls the full season (fixtures, results, quarter-by-quarter scores, and
// full player stat lines) for an entire PlayHQ competition/season - every
// grade, every round, every game - using the same GraphQL API PlayHQ's own
// website calls. No API key needed for these endpoints.
//
// Requires Node.js 18+ (for built-in fetch). Run with:
//   node playhq_scrape.mjs
//
// Output: playhq_season_<SEASON_ID>.json in the current folder.

import fs from "fs";

// ---------------------------------------------------------------------------
// CONFIG — change these for a different competition/season
// ---------------------------------------------------------------------------
const SEASON_ID = "cfa23107"; // "AFL Barwon FNL, 2026"
const TENANT = "afl";
const DISCOVER_ENDPOINT = "https://api.playhq.com/graphql";
// Confirmed via DevTools: the "game" (spectator) query hits a completely
// separate subdomain from the discover API, not the same api.playhq.com host.
const SPECTATOR_ENDPOINT = "https://spectator.playhq.com/graphql";

// Filter grades by age group and gender, using the values PlayHQ itself
// assigns (not name matching, since cup names like "Buckley's Reserves Cup"
// don't literally say "Senior"). Set either to null to disable that filter.
// Age values seen in this competition: U9, U10, U12, U14, U16, U17, U18,
// SENIOR, OPEN. Gender values: BOYS, GIRLS, MENS, MIXED, WOMENS.
const AGE_FILTER = ["U12", "U14", "U16", "U18", "SENIOR"];
const GENDER_FILTER = ["MIXED", "BOYS", "MENS"];

const REQUEST_DELAY_MS = 1200; // be polite, avoid hammering the API / tripping WAF

// Player-level stats (per-player goals, best players) come from the
// 'gameView' query on the discover API - the same endpoint/host used for
// fixtures. This works for games scored after the fact as well as live
// e-scored ones, unlike the spectator API's 'game' query which only covers
// electronically scored matches. Team-level results, including
// quarter-by-quarter scores, come from the fixture query regardless.
const FETCH_PLAYER_STATS = true;

// ---------------------------------------------------------------------------
// GraphQL queries (captured verbatim from the PlayHQ frontend's own requests)
// ---------------------------------------------------------------------------

const GRADE_LIST_QUERY = `
query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition {
      id
      name
      type
      organisation {
        ...OrganisationDetails
        __typename
      }
      __typename
    }
    status {
      name
      value
      __typename
    }
    grades {
      id
      name
      day {
        name
        value
        __typename
      }
      gender {
        name
        value
        __typename
      }
      age {
        name
        value
        __typename
      }
      __typename
    }
    __typename
  }
  tenantConfiguration {
    label
    competition {
      ageGroups {
        name
        value
        __typename
      }
      genders {
        name
        value
        __typename
      }
      __typename
    }
    ...TenantContactRolesConfiguration
    __typename
  }
}

fragment OrganisationDetails on DiscoverOrganisation {
  id
  type
  name
  email
  contactNumber
  websiteUrl
  address {
    id
    line1
    suburb
    postcode
    state
    country
    __typename
  }
  logo {
    sizes {
      url
      dimensions {
        width
        height
        __typename
      }
      __typename
    }
    __typename
  }
  contacts {
    id
    firstName
    lastName
    position
    email
    phone
    __typename
  }
  shopVisible
  __typename
}

fragment TenantContactRolesConfiguration on TenantConfiguration {
  contactRoles {
    name
    value
    __typename
  }
  __typename
}
`;

const GRADE_ROUNDS_QUERY = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    hideScores
    dates
    rounds {
      id
      number
      abbreviatedName
      isFinalsRound
      current
      provisionalDates
    }
    __typename
  }
}`;

const FIXTURE_BY_ROUND_QUERY = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    ...RoundFixtureFragment
    __typename
  }
}

fragment RoundFixtureFragment on DiscoverRoundFixture {
  byes {
    ...RoundFixtureDiscoverTeamFragment
    __typename
  }
  games {
    id
    alias
    pool {
      id
      name
      __typename
    }
    away {
      ...RoundFixtureTeamFragment
      __typename
    }
    home {
      ...RoundFixtureTeamFragment
      __typename
    }
    result {
      winner {
        name
        value
        __typename
      }
      outcome {
        name
        value
        __typename
      }
      home {
        outcome {
          name
          value
          __typename
        }
        statistics {
          count
          type {
            value
            __typename
          }
          __typename
        }
        periods {
          period {
            label
            value
            __typename
          }
          type
          closureStatus
          statistics {
            count
            type {
              label
              value
              __typename
            }
            __typename
          }
          __typename
        }
        gameOutcomeDescription
        __typename
      }
      away {
        outcome {
          name
          value
          __typename
        }
        statistics {
          count
          type {
            value
            __typename
          }
          __typename
        }
        periods {
          period {
            label
            value
            __typename
          }
          type
          closureStatus
          statistics {
            count
            type {
              label
              value
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    status {
      name
      value
      __typename
    }
    date
    dates
    allocation {
      time
      dateTimeList {
        date
        time
        __typename
      }
      court {
        id
        name
        abbreviatedName
        latitude
        longitude
        venue {
          id
          name
          abbreviatedName
          latitude
          longitude
          address
          suburb
          state
          postcode
          country
          __typename
        }
        __typename
      }
      __typename
    }
    isStale
    gameType {
      name
      value
      eScoringSettings {
        dismissalsPerBatter
        legalBallsPerOver
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}

fragment RoundFixtureDiscoverTeamFragment on DiscoverTeam {
  id
  name
  logo {
    sizes {
      url
      dimensions {
        width
        height
        __typename
      }
      __typename
    }
    __typename
  }
  season {
    id
    name
    competition {
      id
      name
      __typename
    }
    __typename
  }
  organisation {
    id
    name
    type
    __typename
  }
  __typename
}

fragment RoundFixtureTeamFragment on DiscoverPossibleTeam {
  ... on ProvisionalTeam {
    name
    pool {
      id
      name
      __typename
    }
    __typename
  }
  ...RoundFixtureDiscoverTeamFragment
  __typename
}
`;

const GAME_QUERY = `
query game($id: ID!, $scope: PeriodScore) {
  game(id: $id) {
    ...GameFragment
    __typename
  }
}

fragment GameFragment on Game {
  id
  status
  updatedAt
  lastEventRecordedAt
  statistics {
    home {
      statisticsV2 {
        type {
          type
          value
          __typename
        }
        count
        __typename
      }
      players {
        id
        profileID
        name
        playerNumber
        periodStatistics {
          period {
            value
            __typename
          }
          side
          type
          statistics {
            type {
              value
              __typename
            }
            count
            __typename
          }
          status
          displayOrder
          __typename
        }
        statistics {
          type {
            value
            __typename
          }
          count
          __typename
        }
        permitType
        __typename
      }
      __typename
    }
    away {
      statisticsV2 {
        type {
          type
          value
          __typename
        }
        count
        __typename
      }
      players {
        id
        profileID
        name
        playerNumber
        periodStatistics {
          period {
            value
            __typename
          }
          side
          type
          statistics {
            type {
              value
              __typename
            }
            count
            __typename
          }
          status
          displayOrder
          __typename
        }
        statistics {
          type {
            type
            value
            __typename
          }
          count
          __typename
        }
        permitType
        __typename
      }
      __typename
    }
    shared {
      period {
        value
        __typename
      }
      side
      __typename
    }
    __typename
  }
  result {
    home {
      statistics {
        type {
          value
          __typename
        }
        count
        __typename
      }
      periods(scope: $scope) {
        period {
          label
          shortName
          value
          __typename
        }
        statistics {
          type {
            type
            value
            __typename
          }
          count
          __typename
        }
        type
        role
        closureStatus
        overtimeSequenceNo
        __typename
      }
      __typename
    }
    away {
      statistics {
        type {
          type
          value
          __typename
        }
        count
        __typename
      }
      periods(scope: $scope) {
        period {
          label
          shortName
          value
          __typename
        }
        statistics {
          type {
            type
            value
            __typename
          }
          count
          __typename
        }
        type
        role
        closureStatus
        overtimeSequenceNo
        __typename
      }
      __typename
    }
    currentPeriod {
      value
      primarySide
      __typename
    }
    __typename
  }
  break
  latestEvent {
    id
    title
    description
    visible
    requireReload
    sportEventStamp
    eventSection
    timestamp
    previousEventID
    side
    period
    ... on ScoreEvent {
      progressiveScore
      score
      __typename
    }
    ... on FoulEvent {
      type
      __typename
    }
    ... on DismissalEvent {
      icon
      __typename
    }
    ... on ExtraEvent {
      icon
      __typename
    }
    ... on PeriodSummaryEvent {
      summary {
        ... on OverSummary {
          side
          batters {
            playerID
            name
            score
            __typename
          }
          bowlers {
            playerID
            name
            score
            __typename
          }
          title
          progressiveStatistics
          scoreSummary
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
  clock {
    overtimeSequenceNo
    period
    periodValue
    status
    time
    lastUpdatedAt
    __typename
  }
  __typename
}
`;

const GAME_VIEW_QUERY = `query gameView($gameId: ID!, $gameStatisticsFilter: GameStatisticsFilter!) {
  discoverGame(gameID: $gameId) {
    id
    alias
    away {
      ...TeamFragment
      __typename
    }
    home {
      ...TeamFragment
      __typename
    }
    result {
      winner {
        name
        value
        __typename
      }
      outcome {
        name
        value
        __typename
      }
      home {
        score
        outcome {
          name
          value
          __typename
        }
        statistics {
          count
          type {
            value
            __typename
          }
          __typename
        }
        periods {
          period {
            label
            value
            __typename
          }
          type
          closureStatus
          statistics {
            count
            type {
              label
              value
              __typename
            }
            __typename
          }
          __typename
        }
        gameOutcomeDescription
        revisedTarget {
          type
          runs
          overLimit
          __typename
        }
        __typename
      }
      away {
        score
        outcome {
          name
          value
          __typename
        }
        statistics {
          count
          type {
            value
            __typename
          }
          __typename
        }
        periods {
          period {
            label
            value
            __typename
          }
          type
          closureStatus
          statistics {
            count
            type {
              label
              value
              __typename
            }
            __typename
          }
          __typename
        }
        revisedTarget {
          type
          runs
          overLimit
          __typename
        }
        __typename
      }
      __typename
    }
    status {
      name
      value
      __typename
    }
    round {
      id
      name
      abbreviatedName
      grade {
        id
        name
        day {
          name
          value
          __typename
        }
        hideScores
        season {
          id
          name
          competition {
            id
            name
            organisation {
              ...OrganisationDetails
              __typename
            }
            __typename
          }
          __typename
        }
        gameEvents {
          participantEvents {
            type
            label
            shortName
            value
            pointValue
            applicableTo
            advanced
            __typename
          }
          periodEvents {
            value
            __typename
          }
          __typename
        }
        hasPeriodScores
        periodScoresDisplayType {
          name
          value
          __typename
        }
        periods {
          shortName
          value
          __typename
        }
        playerPoints {
          enforceTeamTotalCap
          teamPlayerPointsCap
          publicVisible
          __typename
        }
        bestPlayers {
          max
          __typename
        }
        gameStatisticsConfiguration {
          gameStatistics(filter: $gameStatisticsFilter) {
            type
            glossary {
              default {
                name
                shortName
                message
                labelName
                __typename
              }
              scoring {
                name
                shortName
                message
                labelName
                __typename
              }
              __typename
            }
            value
            pointValue
            applicableTo
            required
            max
            __typename
          }
          __typename
        }
        lineupRemainsWhenGameStarted
        __typename
      }
      __typename
    }
    date
    dates
    allocation {
      time
      dateTimeList {
        date
        time
        __typename
      }
      court {
        id
        abbreviatedName
        name
        venue {
          id
          name
          latitude
          longitude
          address
          suburb
          state
          postcode
          __typename
        }
        __typename
      }
      __typename
    }
    statistics {
      home {
        ...GameViewGameTeamStatisticsFragment
        __typename
      }
      away {
        ...GameViewGameTeamStatisticsFragment
        __typename
      }
      shared {
        period {
          label
          shortName
          value
          __typename
        }
        type
        status
        statistics {
          count
          type {
            value
            __typename
          }
          __typename
        }
        side
        players {
          playerID
          teamID
          role
          __typename
        }
        dismissalType
        displayOrder
        __typename
      }
      __typename
    }
    publishLineup
    gameType {
      name
      value
      maxBattersPerInnings
      eScoringSettings {
        dismissalsPerBatter
        legalBallsPerOver
        __typename
      }
      emergencyPlayersSettings {
        enabled
        __typename
      }
      playerPositionsSettings {
        isInGamePositionsLineupVisible
        __typename
      }
      clockType
      __typename
    }
    formation {
      template
      __typename
    }
    __typename
  }
  tenantConfiguration {
    label
    statistics {
      enabled
      __typename
    }
    showPlayerPositionsInLineup
    showDuckIconInBattingTable
    periodType {
      value
      __typename
    }
    gameTypes {
      gameType {
        value
        __typename
      }
      gameTypeFeatures {
        lineupOrderingEnabled
        __typename
      }
      __typename
    }
    ...TenantContactRolesConfiguration
    __typename
  }
}

fragment TeamFragment on DiscoverPossibleTeam {
  ... on ProvisionalTeam {
    name
    pool {
      id
      name
      __typename
    }
    __typename
  }
  ...DiscoverTeamFragment
  __typename
}

fragment DiscoverTeamFragment on DiscoverTeam {
  id
  name
  logo {
    sizes {
      url
      dimensions {
        width
        height
        __typename
      }
      __typename
    }
    __typename
  }
  season {
    id
    name
    competition {
      id
      name
      __typename
    }
    __typename
  }
  organisation {
    id
    name
    type
    __typename
  }
  playerPointsCap
  __typename
}

fragment OrganisationDetails on DiscoverOrganisation {
  id
  type
  name
  email
  contactNumber
  websiteUrl
  address {
    id
    line1
    suburb
    postcode
    state
    country
    __typename
  }
  logo {
    sizes {
      url
      dimensions {
        width
        height
        __typename
      }
      __typename
    }
    __typename
  }
  contacts {
    id
    firstName
    lastName
    position
    email
    phone
    __typename
  }
  shopVisible
  __typename
}

fragment GameViewGameTeamStatisticsFragment on DiscoverGameTeamStatistics {
  players {
    playerNumber
    player {
      ... on DiscoverParticipant {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        hasSeasonPermit
        memberships {
          ...ShortTermMembershipFields
          __typename
        }
        __typename
      }
      ... on DiscoverParticipantFillInPlayer {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        hasSeasonPermit
        __typename
      }
      ... on DiscoverGamePermitFillInPlayer {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        __typename
      }
      ... on DiscoverRegularFillInPlayer {
        id
        name
        __typename
      }
      ... on DiscoverAnonymousParticipant {
        id
        name
        hasGamePermit
        hasSeasonPermit
        __typename
      }
      __typename
    }
    statistics {
      count
      type {
        value
        __typename
      }
      __typename
    }
    periodStatistics {
      period {
        label
        shortName
        value
        __typename
      }
      type
      statistics {
        type {
          type
          label
          shortName
          value
          pointValue
          applicableTo
          advanced
          __typename
        }
        count
        details {
          value
          __typename
        }
        __typename
      }
      status
      side
      displayOrder
      __typename
    }
    periods {
      period {
        label
        shortName
        value
        __typename
      }
      overtimeSequenceNo
      inGamePositions {
        shortName
        __typename
      }
      __typename
    }
    playerPoints
    playerPosition {
      positionType
      shortName
      order
      __typename
    }
    captain {
      name
      shortName
      __typename
    }
    lineupOrder
    __typename
  }
  statistics {
    count
    type {
      value
      pointValue
      __typename
    }
    __typename
  }
  periods {
    period {
      value
      __typename
    }
    overtimeSequenceNo
    statistics {
      type {
        value
        __typename
      }
      count
      __typename
    }
    teamEvents {
      sequenceNo
      playerID
      statistic {
        type {
          value
          __typename
        }
        count
        __typename
      }
      __typename
    }
    __typename
  }
  emergencyPlayers {
    playerNumber
    playerPoints
    player {
      ... on DiscoverParticipant {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        hasSeasonPermit
        __typename
      }
      ... on DiscoverParticipantFillInPlayer {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        hasSeasonPermit
        __typename
      }
      ... on DiscoverGamePermitFillInPlayer {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        __typename
      }
      ... on DiscoverAnonymousParticipant {
        id
        name
        hasGamePermit
        hasSeasonPermit
        __typename
      }
      __typename
    }
    __typename
  }
  bestPlayers {
    participant {
      ... on DiscoverParticipant {
        id
        profile {
          id
          firstName
          lastName
          __typename
        }
        __typename
      }
      ... on DiscoverAnonymousParticipant {
        name
        __typename
      }
      __typename
    }
    ranking
    __typename
  }
  coinTossWinningResult {
    preference
    __typename
  }
  __typename
}

fragment ShortTermMembershipFields on Membership {
  history {
    startDate
    expiryDate
    purchaseDate
    __typename
  }
  categoryBasedFee {
    tenantPeriod {
      period
      isShortTerm
      __typename
    }
    __typename
  }
  organisation {
    id
    type
    name
    __typename
  }
  __typename
}

fragment TenantContactRolesConfiguration on TenantConfiguration {
  contactRoles {
    name
    value
    __typename
  }
  __typename
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gqlRaw(url, tenant, operationName, query, variables) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Tenant: tenant,
      "x-phq-tenant": tenant,
      Origin: "https://www.playhq.com",
      Referer: "https://www.playhq.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `HTTP ${res.status} calling ${operationName} at ${url}\n${text.slice(0, 500)}`
    );
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(
      `GraphQL errors on ${operationName}: ${JSON.stringify(json.errors)}`
    );
  }
  return json.data;
}

// Transient errors (bot-detection blocks, rate limits, server hiccups) are
// worth retrying with a growing delay. Real problems (bad query, wrong
// argument names) come back as 400s with GraphQL validation errors and
// should fail fast instead of retrying 4 times for nothing.
const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

async function gql(url, tenant, operationName, query, variables) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await gqlRaw(url, tenant, operationName, query, variables);
    } catch (err) {
      lastErr = err;
      const retryable = err.status && RETRYABLE_STATUS.has(err.status);
      if (!retryable || attempt === MAX_RETRIES) {
        throw err;
      }
      const backoffMs = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s, 40s
      console.warn(
        `  [${operationName}] got HTTP ${err.status}, retrying in ${
          backoffMs / 1000
        }s (attempt ${attempt + 1}/${MAX_RETRIES})...`
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchGrade(gradeId, gradeName) {
  console.log(`\n=== Grade: ${gradeName} (${gradeId}) ===`);

  const gradeData = await gql(
    DISCOVER_ENDPOINT,
    TENANT,
    "gradeRounds",
    GRADE_ROUNDS_QUERY,
    { gradeID: gradeId }
  );

  const grade = gradeData.discoverGrade;
  if (!grade) {
    console.warn(`  No data returned for grade ${gradeId}, skipping.`);
    return null;
  }

  console.log(`  ${grade.rounds.length} rounds found`);

  const gradeOut = {
    gradeId,
    gradeName: grade.name,
    hideScores: grade.hideScores,
    rounds: [],
  };

  for (const round of grade.rounds) {
    console.log(
      `  Round ${round.number} (${round.abbreviatedName}) - fetching fixture...`
    );
    await sleep(REQUEST_DELAY_MS);

    let fixtureData;
    try {
      fixtureData = await gql(
        DISCOVER_ENDPOINT,
        TENANT,
        "discoverFixtureByRound",
        FIXTURE_BY_ROUND_QUERY,
        { roundID: round.id }
      );
    } catch (err) {
      console.warn(`    Could not fetch round ${round.id}: ${err.message}`);
      continue;
    }

    const fixture = fixtureData.discoverFixtureByRound;
    const roundOut = {
      roundId: round.id,
      roundNumber: round.number,
      abbreviatedName: round.abbreviatedName,
      isFinalsRound: round.isFinalsRound,
      byes: (fixture.byes || []).map((t) => ({
        teamId: t.id,
        teamName: t.name,
      })),
      games: [],
    };

    for (const game of fixture.games || []) {
      const gameOut = {
        gameId: game.id,
        date: game.date,
        time: game.allocation?.time || null,
        venue: game.allocation?.court?.venue?.name || null,
        court: game.allocation?.court?.name || null,
        status: game.status?.value,
        home: {
          teamId: game.home?.id,
          teamName: game.home?.name,
        },
        away: {
          teamId: game.away?.id,
          teamName: game.away?.name,
        },
        result: game.result || null, // quarter scores already included here
        fullStats: null, // filled in below for completed games
      };

      const isFinished =
        game.status?.value === "FINAL" ||
        game.status?.value === "COMPLETE" ||
        !!game.result;

      if (isFinished && FETCH_PLAYER_STATS) {
        await sleep(REQUEST_DELAY_MS);
        try {
          const gameData = await gql(
            DISCOVER_ENDPOINT,
            TENANT,
            "gameView",
            GAME_VIEW_QUERY,
            {
              gameId: game.id,
              gameStatisticsFilter: { classification: "TOTAL" },
            }
          );
          gameOut.fullStats = gameData.discoverGame;
        } catch (err) {
          console.warn(
            `    Could not fetch full stats for ${game.id}: ${err.message}`
          );
        }
      }

      roundOut.games.push(gameOut);
    }

    gradeOut.rounds.push(roundOut);
  }

  return gradeOut;
}

async function main() {
  console.log(`Fetching grade list for season ${SEASON_ID}...`);
  const seasonData = await gql(
    DISCOVER_ENDPOINT,
    TENANT,
    "gradeListDiscoverSeason",
    GRADE_LIST_QUERY,
    { id: SEASON_ID }
  );

  const discoverSeason = seasonData.discoverSeason;
  if (!discoverSeason) {
    throw new Error(
      "No season returned - check SEASON_ID and TENANT are correct."
    );
  }

  let grades = discoverSeason.grades;
  console.log(
    `Season: ${discoverSeason.competition?.name} ${discoverSeason.name} — ${grades.length} grades found`
  );

  if (AGE_FILTER) {
    grades = grades.filter((g) => AGE_FILTER.includes(g.age?.value));
  }
  if (GENDER_FILTER) {
    grades = grades.filter((g) => GENDER_FILTER.includes(g.gender?.value));
  }
  console.log(`Filtered to ${grades.length} grades matching age/gender filters`);

  const outFile = `playhq_season_${SEASON_ID}.json`;
  const season = {
    seasonId: SEASON_ID,
    competitionName: discoverSeason.competition?.name,
    seasonName: discoverSeason.name,
    grades: [],
  };

  const alreadyDone = new Set();
  if (fs.existsSync(outFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
      season.grades = existing.grades || [];
      for (const g of season.grades) alreadyDone.add(g.gradeId);
      console.log(
        `Found existing ${outFile} with ${season.grades.length} grade(s) already done - resuming, will skip those.`
      );
    } catch {
      // ignore unreadable/corrupt existing file, start fresh
    }
  }

  for (const grade of grades) {
    if (alreadyDone.has(grade.id)) {
      console.log(`\n=== Grade: ${grade.name} (${grade.id}) — already done, skipping ===`);
      continue;
    }

    try {
      const gradeOut = await fetchGrade(grade.id, grade.name);
      if (gradeOut) {
        season.grades.push(gradeOut);
      }
    } catch (err) {
      console.error(
        `  Grade ${grade.name} (${grade.id}) failed entirely, skipping: ${err.message}`
      );
    }

    // Save after every grade (success or partial failure) so a crash or
    // block doesn't lose everything fetched so far. Re-running the script
    // will pick up where it left off.
    fs.writeFileSync(outFile, JSON.stringify(season, null, 2));
    console.log(`  (progress saved to ${outFile})`);
  }

  console.log(`\nDone. Wrote ${outFile}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
