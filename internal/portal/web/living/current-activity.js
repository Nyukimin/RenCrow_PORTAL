(function (global) {
  "use strict";

  var labelsByKind = Object.freeze({
    work: Object.freeze(["日記を書く", "レビュー中", "調査中", "分析中", "執筆中", "作業中"]),
    chat: Object.freeze(["会話中", "ミオと会話中", "シロと会話中", "ミドリと会話中", "クロと会話中", "アカと会話中", "アオと会話中", "キンと会話中", "ギンと会話中"]),
    hobby: Object.freeze(["趣味中", "ファッション中", "動画の企画中", "映画リサーチ中", "トレーニング中", "オタク文化中", "ミラーポーズ中", "読書中", "マンガ文化中", "音楽中", "物語の企画中"]),
    rest: Object.freeze(["休憩中"]),
    sleep: Object.freeze(["就寝予定", "就寝中", "起床中", "就寝準備中"]),
    moving: Object.freeze(["移動中"]),
    game: Object.freeze(["NetHackをプレイ中", "Territory Commanderをプレイ中", "Survival Gardenをプレイ中", "ヘルツォーク・ツヴァイをプレイ中", "ゲーム中", "NetHackを準備中", "Territory Commanderを準備中", "Survival Gardenを準備中", "ヘルツォーク・ツヴァイを準備中", "ゲームを準備中"]),
    evaluating: Object.freeze(["次の活動を選択中"]),
    routine: Object.freeze(["活動中"])
  });
  var phasesByKind = Object.freeze({
    work: Object.freeze(["working"]), chat: Object.freeze(["talking"]), hobby: Object.freeze(["active"]),
    rest: Object.freeze(["resting"]), sleep: Object.freeze(["sleep_window", "sleeping", "waking", "preparing"]),
    moving: Object.freeze(["in_transit"]), game: Object.freeze(["playing", "preparing"]),
    evaluating: Object.freeze(["waiting"]), routine: Object.freeze(["active"])
  });
  var actorsByName = Object.freeze({
    "ミオ": "mio", "シロ": "shiro", "ミドリ": "midori", "クロ": "kuro",
    "アカ": "aka", "アオ": "ao", "キン": "kin", "ギン": "gin"
  });
  var hobbiesByActor = Object.freeze({
    mio: Object.freeze(["ファッション中", "動画の企画中"]),
    shiro: Object.freeze(["映画リサーチ中", "トレーニング中"]),
    kuro: Object.freeze(["オタク文化中", "ミラーポーズ中"]),
    midori: Object.freeze(["読書中", "マンガ文化中", "音楽中", "物語の企画中"])
  });

  function isValid(value, actorID) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    var keys = Object.keys(value).sort();
    if (keys.length !== 4 || keys.join(",") !== "kind,label,phase,revision" ||
        typeof value.kind !== "string" || typeof value.label !== "string" || typeof value.phase !== "string" ||
        !Number.isSafeInteger(value.revision) || value.revision <= 0) return false;
    var labels = labelsByKind[value.kind];
    var phases = phasesByKind[value.kind];
    if (!labels || !phases || !labels.includes(value.label) || !phases.includes(value.phase)) return false;
    if (value.kind === "chat" && value.label !== "会話中") {
      if (!value.label.endsWith("と会話中")) return false;
      var partnerName = value.label.slice(0, -4);
      var partnerID = actorsByName[partnerName];
      if (!partnerID || (actorID && partnerID === actorID)) return false;
    }
    if (value.kind === "hobby" && value.label !== "趣味中" && actorID && !(hobbiesByActor[actorID] || []).includes(value.label)) return false;
    if (value.kind === "sleep") {
      return value.label === ({ sleep_window: "就寝予定", sleeping: "就寝中", waking: "起床中", preparing: "就寝準備中" })[value.phase];
    }
    if (value.kind === "game") {
      var gameLabelsByPhase = {
        playing: ["NetHackをプレイ中", "Territory Commanderをプレイ中", "Survival Gardenをプレイ中", "ヘルツォーク・ツヴァイをプレイ中", "ゲーム中"],
        preparing: ["NetHackを準備中", "Territory Commanderを準備中", "Survival Gardenを準備中", "ヘルツォーク・ツヴァイを準備中", "ゲームを準備中"]
      };
      return gameLabelsByPhase[value.phase].includes(value.label);
    }
    return true;
  }

  global.RenCrowCurrentActivity = Object.freeze({ isValid: isValid });
})(window);
