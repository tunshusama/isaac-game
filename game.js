"use strict";

const WIDTH = 960;
const HEIGHT = 540;
// 原版几何（assets/ref/notes.md §0）：房间内部 13×7 格 × 52px = 676×364，
// 左右各 142px 墙带、上下各 88px；画布中心即房间中心
const ROOM = {
  left: 142,
  right: 818,
  top: 88,
  bottom: 452,
  cx: 480,
  cy: 270,
};
// 1×1 基准单元尺寸（13×7 格 × 52px）：多尺寸房（1×2/2×1/2×2）按单元整块外扩，
// ROOM 只保留为单元派生基准，当前房可视边界一律走 curRoomRect()
const CELL_W = ROOM.right - ROOM.left; // 676
const CELL_H = ROOM.bottom - ROOM.top; // 364
const WALL_X = ROOM.left; // 侧墙带宽 142
const WALL_Y = ROOM.top; // 顶/底墙带宽 88
const DEPTH = {
  room: 0,
  backdrop: -2,
  pickup: 16,
  actor: 20,
  projectile: 24,
  fx: 40,
  ui: 100,
  overlay: 120,
};

const SFX = {
  ctx: null,
  last: {},
  muted: false,
  ensure() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    } catch (err) {
      return null;
    }
  },
  beep(freq, dur, { type = "sine", vol = 0.08, slide = 0, delay = 0 } = {}) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },
  noise(dur, vol = 0.14) {
    const ctx = this.ensure();
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.buffer = buffer;
    src.connect(gain).connect(ctx.destination);
    src.start();
  },
  play(name) {
    if (this.muted) return;
    const now = performance.now();
    if (this.last[name] && now - this.last[name] < 50) return;
    this.last[name] = now;
    switch (name) {
      case "shoot": this.beep(560, 0.07, { type: "square", vol: 0.045, slide: 320 }); break;
      case "hit": this.beep(220, 0.05, { type: "triangle", vol: 0.06, slide: 160 }); break;
      case "die": this.beep(170, 0.16, { type: "sawtooth", vol: 0.08, slide: 60 }); break;
      case "hurt": this.beep(240, 0.22, { type: "sawtooth", vol: 0.14, slide: 80 }); break;
      case "coin": this.beep(880, 0.09, { vol: 0.07, slide: 1320 }); break;
      case "heart": this.beep(520, 0.14, { vol: 0.08, slide: 700 }); break;
      case "key": this.beep(660, 0.1, { type: "triangle", vol: 0.08, slide: 990 }); break;
      case "item":
        this.beep(440, 0.1, { vol: 0.09 });
        this.beep(660, 0.1, { vol: 0.09, delay: 0.09 });
        this.beep(880, 0.16, { vol: 0.09, delay: 0.18 });
        break;
      case "boom": this.noise(0.32, 0.2); this.beep(120, 0.3, { vol: 0.16, slide: 40 }); break;
      case "door": this.beep(300, 0.12, { type: "triangle", vol: 0.07, slide: 210 }); break;
      case "clear": this.beep(523, 0.1, { vol: 0.08 }); this.beep(784, 0.16, { vol: 0.08, delay: 0.1 }); break;
      case "roar": this.beep(95, 0.45, { type: "sawtooth", vol: 0.16, slide: 55 }); break;
      case "devil": this.beep(70, 0.6, { type: "sawtooth", vol: 0.12, slide: 50 }); break;
      case "unlock":
        this.beep(440, 0.08, { type: "triangle", vol: 0.08 });
        this.beep(587, 0.12, { type: "triangle", vol: 0.08, delay: 0.07 });
        break;
      case "summon": this.beep(330, 0.2, { type: "square", vol: 0.07, slide: 110 }); break;
      default: break;
    }
  },
};

// 程序化背景音乐：A 小调贝斯走向（8 分音符一步）+ 底鼓，音量压在 SFX 之下。
// lookahead 调度：setInterval 定期把未来 0.25s 内的音符写进 AudioContext 时间轴。
// Boss 房切更急促的 mood（更快节拍 + 更密底鼓 + 贝斯高八度）。
const MUSIC = {
  timer: null,
  nextTime: 0,
  step: 0,
  bus: null,
  muted: false,
  mood: "normal",
  // A1 _ A1 _ C2 _ A1 _ G1 _ G1 _ Bb1 _ C2 _（Bb 提供小调紧张感，0 = 休止）
  bassLine: [55, 0, 55, 0, 65.41, 0, 55, 0, 49, 0, 49, 0, 58.27, 0, 65.41, 0],
  stepDur() {
    return 60 / (this.mood === "boss" ? 132 : 92) / 2;
  },
  start() {
    if (this.timer || this.muted) return;
    const ctx = SFX.ensure();
    if (!ctx) return;
    if (!this.bus) {
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.5; // 总线先压一半，保证音乐始终低于音效
      this.bus.connect(ctx.destination);
    }
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.tick(), 80);
  },
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },
  setMuted(muted) {
    this.muted = muted;
    if (muted) this.stop();
    else this.start();
  },
  setMood(mood) {
    this.mood = mood;
  },
  tick() {
    const ctx = SFX.ctx;
    if (!ctx || ctx.state === "suspended") return;
    while (this.nextTime < ctx.currentTime + 0.25) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += this.stepDur();
      this.step = (this.step + 1) % this.bassLine.length;
    }
  },
  scheduleStep(step, t) {
    const kickEvery = this.mood === "boss" ? 2 : 4; // Boss 房底鼓翻倍，更急促
    if (step % kickEvery === 0) this.kick(t);
    const freq = this.bassLine[step];
    if (freq) this.bass(freq * (this.mood === "boss" ? 2 : 1), t, this.stepDur() * 0.9);
  },
  bass(freq, t, dur) {
    const ctx = SFX.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },
  kick(t) {
    const ctx = SFX.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    gain.gain.setValueAtTime(0.32, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(gain).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.15);
  },
};

// 页面隐藏时停音乐，回前台恢复（避免后台空转）
document.addEventListener("visibilitychange", () => {
  if (document.hidden) MUSIC.stop();
  else MUSIC.start();
});

const MAX_FLOOR = 3;
// 血量单位为半心：初始 hp 6 = 3 颗红心；触碰/敌子弹=1（半心），Boss 触碰/尖刺/自炸=2（1 整心）
const SOUL_HP_MAX = 20; // 魂心上限（半心单位，即 10 颗）
// 泪弹抛物线：高度 z 受重力回落，命中判定用地面投影 + 高度容忍
const TEAR_GRAVITY = 720;
const TEAR_HIT_HEIGHT = 60;
// 炸弹：引信、爆炸半径、伤害（约玩家基础伤害×10）
const BOMB_FUSE = 1500;
const BOMB_RADIUS = 90;
const BOMB_DAMAGE = 10;
// 出口类触发（恶魔房返回门/楼层活板门）的换房冷却：切换房间后该时长内不响应出口重叠
const EXIT_GRACE_MS = 600;
// 实体名 -> 贴图 key（对应 preload 里注册的原版素材）；未列出的实体 kind 与贴图 key 同名
const SPRITES = {
  player: "isaac",
  crawler: "gaper",
  boss: "monstro",
  rock: "rocks",
  pillar: "pillars",
  pot: "poop",
  spikes: "spikes",
  heart: "redHeart",
  coin: "penny",
  key: "key",
  bomb: "bomb",
  pill: "pill",
  bossSmall: "gaper",
  passive: "itemHalo",
  candle: "firePlace",
  potion: "itemMushroom",
};

// 飞行怪集合：越过岩石/沟壑等障碍（跳蛙仅在滞空时可视作飞行，见 collider 回调）
const ENEMY_FLYING = new Set(["fly", "pooter", "boomFly"]);

// 精英（Champion）三色语义 + 稀有金（原版规则）：
// 红=更硬掉红心 / 蓝=掉魂心 / 黑=掉炸弹 / 金=10% 稀有超级精英，双倍掉落
const CHAMPION_TYPES = {
  red: { tint: 0xd94a3a, hpMul: 2.6, scale: 1.32, drop: "heart" },
  blue: { tint: 0x6a8adc, hpMul: 2.2, scale: 1.32, drop: "soulHeart" },
  black: { tint: 0x35323a, hpMul: 2.2, scale: 1.32, drop: "bomb" },
  gold: { tint: 0xe0a44a, hpMul: 3.0, scale: 1.45, drop: "gold" },
};

// 隐藏类房型（普通隐藏房 + 超级隐藏房）：通行/小地图/炸墙发现等逻辑一视同仁
const SECRET_TYPES = new Set(["hidden", "superSecret"]);

// 官方小地图房型图标（wiki.gg 9×8 原图，assets/isaac-src 内嵌）：paintMap 生成
// 像素复制 ×3 的 crisp 纹理后按 tile 贴图章；恶魔房保留原纯色块（其门洞有红门提示）
const MAP_ICONS = {
  treasure: "treasureRoomIcon",
  shop: "shopIcon",
  boss: "bossRoomIcon",
  hidden: "secretRoomIcon",
  superSecret: "superSecretRoomIcon",
};

// 道具池：忏悔经典道具（官方中文名），效果沿用本项目数值体系；iconFrame 指向官方道具贴图
const ITEM_POOL = [
  {
    name: "复眼",
    desc: "泪弹 +1",
    type: "passive",
    iconFrame: "itemTheInnerEye",
    apply: (player) => {
      player.shots += 1;
    },
  },
  {
    name: "五芒星",
    desc: "伤害提升",
    type: "passive",
    iconFrame: "itemPentagram",
    apply: (player) => {
      player.damage += 0.55;
    },
  },
  {
    name: "皮带",
    desc: "移速提升",
    type: "passive",
    iconFrame: "itemTheBelt",
    apply: (player) => {
      player.speed += 28;
    },
  },
  {
    name: "衣架",
    desc: "射速提升",
    type: "passive",
    iconFrame: "itemWireHanger",
    apply: (player) => {
      player.fireDelay = Math.max(120, player.fireDelay - 55);
    },
  },
  {
    name: "伤心洋葱",
    desc: "射速提升",
    type: "passive",
    iconFrame: "itemTheSadOnion",
    apply: (player) => {
      player.fireDelay = Math.max(125, player.fireDelay - 35);
    },
  },
  {
    name: "巫师帽",
    desc: "斜向散射",
    type: "passive",
    iconFrame: "itemTheWiz",
    apply: (player) => {
      player.spread += 1;
    },
  },
  {
    name: "早餐",
    desc: "生命提升",
    type: "passive",
    iconFrame: "itemBreakfast",
    apply: (player) => {
      player.maxHp += 2; // +1 心容器（半心单位）
      player.hp = Math.min(player.maxHp, player.hp + 2);
    },
  },
  {
    name: "午餐",
    desc: "生命提升",
    type: "passive",
    iconFrame: "itemLunch",
    apply: (player) => {
      player.maxHp += 2; // +1 心容器（半心单位）
      player.hp = Math.min(player.maxHp, player.hp + 2);
    },
  },
  {
    name: "光环",
    desc: "全属性小幅提升",
    type: "passive",
    iconFrame: "itemTheHalo",
    apply: (player) => {
      player.damage += 0.3;
      player.fireDelay = Math.max(125, player.fireDelay - 25);
      player.tearLife += 60;
      player.speed += 12;
    },
  },
  {
    name: "魔法蘑菇",
    desc: "伤害与射程提升",
    type: "passive",
    iconFrame: "itemMagicMushroom",
    apply: (player) => {
      player.damage += 0.45;
      player.tearLife += 120;
    },
  },
  {
    name: "丘比特之箭",
    desc: "泪弹穿透敌人",
    type: "passive",
    iconFrame: "itemCupidsArrow",
    apply: (player) => {
      player.piercing += 1;
    },
  },
  {
    name: "藏宝图",
    desc: "小地图显示整个楼层",
    type: "passive",
    iconFrame: "itemTreasureMap",
    apply: (player) => {
      player.mapReveal = true;
    },
  },
  {
    name: "幸运脚",
    desc: "幸运提升，金币 +5",
    type: "passive",
    iconFrame: "itemLuckyFoot",
    apply: (player) => {
      player.rewardLuck += 0.18;
      player.coins += 5;
    },
  },
  {
    name: "吸血鬼獠牙",
    desc: "击杀偶尔恢复生命",
    type: "passive",
    iconFrame: "itemCharmOfTheVampire",
    apply: (player) => {
      player.lifesteal += 0.09;
    },
  },
  {
    name: "磁铁",
    desc: "拾取物会被你吸引",
    type: "passive",
    iconFrame: "itemMagnet",
    apply: (player) => {
      player.magnet = true;
    },
  },
  {
    name: "小蘑菇",
    desc: "射程与移速提升",
    type: "passive",
    iconFrame: "itemMiniMush",
    apply: (player) => {
      player.tearLife += 120;
      player.speed += 20;
    },
  },
  {
    name: "波比兄弟",
    desc: "跟班环绕你自动攻击",
    type: "passive",
    iconFrame: "itemBrotherBobby",
    apply: (player) => {
      player.familiars += 1;
    },
  },
  {
    name: "螺丝",
    desc: "射程与弹速提升",
    type: "passive",
    iconFrame: "itemScrew",
    apply: (player) => {
      player.tearLife += 100;
      player.tearSpeed += 70;
    },
  },
  {
    name: "电池",
    desc: "清房充能效率翻倍",
    type: "passive",
    iconFrame: "itemTheBattery",
    apply: (player) => {
      player.chargeBonus += 1; // 清房充能 +1 → +2
    },
  },
  {
    name: "小石头",
    desc: "伤害提升，弹速下降",
    type: "passive",
    iconFrame: "itemThePoop",
    apply: (player) => {
      player.damage += 0.5;
      player.tearSpeed = Math.max(240, player.tearSpeed - 60);
    },
  },
  {
    name: "塔米的头",
    desc: "环形泪弹",
    type: "active",
    iconFrame: "itemTammysHead",
    chargeMax: 1, // 忏悔：1 充能，每清 1 房回满
    activate: (scene) => {
      scene.fireRadialTears(10, 360, scene.playerStats.damage * 0.9);
      scene.burst(scene.player.x, scene.player.y, 0xffc66d, 18);
      return "塔米的头炸开一圈泪弹";
    },
  },
  {
    name: "死灵之书",
    desc: "主动：伤害全房敌人",
    type: "active",
    iconFrame: "itemTheNecronomicon",
    chargeMax: 4, // 忏悔：4 充能
    activate: (scene) => {
      let hit = 0;
      scene.enemies.children.each((enemy) => {
        if (!enemy.active) return;
        hit += 1;
        scene.damageEnemy(enemy, 3.5, 0xd85b6d, false);
      });
      if (hit === 0) return false;
      scene.cameras.main.shake(140, 0.006);
      return "死灵之书震碎了房间里的敌人";
    },
  },
  {
    name: "美味心",
    desc: "主动：恢复 1 生命",
    type: "active",
    iconFrame: "itemYumHeart",
    chargeMax: 4, // 忏悔：4 充能
    activate: (scene) => {
      if (scene.playerStats.hp >= scene.playerStats.maxHp) return false;
      scene.playerStats.hp = Math.min(scene.playerStats.maxHp, scene.playerStats.hp + 2); // 治疗 1 整心
      scene.burst(scene.player.x, scene.player.y, 0x6db7ff, 14);
      return "美味心让你缓过一口气";
    },
  },
  {
    name: "沙漏",
    desc: "主动：减速并削弱敌人",
    type: "active",
    iconFrame: "itemTheHourglass",
    chargeMax: 2, // 忏悔：2 充能
    activate: (scene) => {
      let hit = 0;
      scene.enemies.children.each((enemy) => {
        if (!enemy.active) return;
        hit += 1;
        enemy.slowUntil = scene.time.now + 3600;
        enemy.weakenUntil = scene.time.now + 3600;
        enemy.setTint(0x8d93aa);
      });
      if (hit === 0) return false;
      return "沙漏让敌人的脚步变沉了";
    },
  },
];

const DEVIL_POOL = [
  {
    name: "契约",
    desc: "伤害提升，魂心 +1",
    cost: 2,
    iconFrame: "itemThePact",
    apply: (player) => {
      player.damage += 0.8;
      player.soulHp = Math.min(SOUL_HP_MAX, player.soulHp + 2);
    },
  },
  {
    name: "标记",
    desc: "伤害与移速提升",
    cost: 1,
    iconFrame: "itemTheMark",
    apply: (player) => {
      player.damage += 0.4;
      player.speed += 25;
    },
  },
  {
    name: "巴比伦娼妇",
    desc: "生命垂危时伤害射速提升",
    cost: 2,
    iconFrame: "itemWhoreOfBabylon",
    apply: (player) => {
      player.whoreOfBabylon = true;
    },
  },
  {
    name: "亚巴顿",
    desc: "伤害大幅提升，魂心 +2",
    cost: 2,
    iconFrame: "itemAbaddon",
    apply: (player) => {
      player.damage += 1.1;
      player.soulHp = Math.min(SOUL_HP_MAX, player.soulHp + 4);
    },
  },
  {
    name: "硫磺火",
    desc: "伤害大幅提升，泪弹穿透",
    cost: 2,
    iconFrame: "itemBrimstone",
    apply: (player) => {
      player.damage += 1.2;
      player.piercing += 2;
    },
  },
// 恶魔池扩到 8 件：从 ITEM_POOL 挑 3 件恶魔向（五芒星=伤害/邪教印记、吸血鬼獠牙=吸血、
// 死灵之书=主动咒杀），复用同名条目属性与目击去重，只补 cost（心容器价格）
].concat(
  [
    ["五芒星", 1],
    ["吸血鬼獠牙", 1],
    ["死灵之书", 1],
  ].map(([name, cost]) => ({ ...ITEM_POOL.find((item) => item.name === name), cost })),
);

// 障碍基表：尺寸按 52px 格重定（一格一物，显示近满格）；radius 供摆放间距判定
const OBSTACLE_TYPES = {
  rock: { texture: SPRITES.rock, frames: 6, radius: 26, scaleMin: 0.9, scaleMax: 1.04, size: 50 },
  pillar: { texture: SPRITES.pillar, radius: 26, scaleMin: 0.9, scaleMax: 1.04, size: 76 },
  pot: { texture: SPRITES.pot, radius: 22, scaleMin: 0.9, scaleMax: 1.06, size: 46 },
  spikes: { texture: SPRITES.spikes, radius: 26, scaleMin: 0.94, scaleMax: 1.02, size: 52 },
  candle: { texture: SPRITES.candle, radius: 17, scaleMin: 0.95, scaleMax: 1.05, size: 52 },
  // 沟壑：贴地黑坑，不可通行/不可破坏，飞行怪照常越过；模板字符 T
  // 贴图按楼层选（preload 的 pitBasement/pitCaves/pitDepths 4 帧变体），此值为兜底默认
  pit: { texture: "pitBasement", frames: 4, radius: 26, scaleMin: 1, scaleMax: 1, size: 52 },
  // TNT 桶：HP=1，受击/被炸即爆（复用炸弹爆炸，可连锁）；模板字符 X
  tnt: { texture: "tnt", radius: 22, scaleMin: 0.95, scaleMax: 1.06, size: 44 },
};

// 楼层主题：底图皮肤（roomBackdropKey）/ 障碍权重 / 敌人池 / 碎石颜色，按 this.floor 取用
// （楼层视觉由独立底图承担，不再有全图 tint 字段）
const FLOOR_THEMES = {
  1: {
    name: "地窖",
    // 碎石贴花三色：tools/make-floor-themes.py 从本层地板采样（原色/加深/加亮）
    chips: [0x553129, 0x3d231d, 0x683b32],
    weights: ["rock", "rock", "pillar", "pot", "spikes"],
    // 1F 苍蝇/爬虫主题（原版 Basement：Gaper/Horf/苍蝇/胖蚊/自弃者/跳蛙）
    pool: ["crawler", "crawler", "horf", "fly", "pooter", "mulligan", "hopper"],
    rockFrames: [1, 4], // 岩石图集按楼层取色（地窖只用棕/米白系：帧 0 深灰/帧 2 炭灰归洞穴）
  },
  2: {
    name: "洞穴",
    chips: [0x3c281c, 0x2b1d14, 0x4a3122],
    weights: ["rock", "rock", "rock", "pillar", "pot", "spikes"],
    // 2F 洞窟主题（原版 Caves：蜘蛛系/冲锋/Host 龟壳/霍夫/爆蝇）
    pool: ["spider", "spider", "bigSpider", "charger", "host", "horf", "boomFly"],
    rockFrames: [0, 2, 5], // 洞穴灰/炭/蓝
  },
  3: {
    name: "深处",
    chips: [0x212123, 0x181819, 0x29292b],
    weights: ["rock", "pillar", "pot", "spikes", "spikes", "spikes"],
    // 3F 深处主题（冲锋/吸盘/蜘蛛/Host/自弃者）
    pool: ["charger", "charger", "sucker", "sucker", "spider", "host", "mulligan"],
    rockFrames: [1, 3], // 深处暗红
  },
};
// 房间布局模板库：13 列 × 7 行 ASCII 网格
// （.空 R岩石 L柱子 P便便 F火堆 S尖刺 T沟壑 XTNT桶；站位标记 G crawler / H horf(霍夫) / Y fly /
//  C charger / B boomFly(爆蝇) / U host(龟壳) / N pooter(胖蚊) / J hopper(跳蛙) / W spider(红蜘蛛)）。
// 模仿原版地窖层手工房间：全部左右对称（每行都是回文）；北/南门列（5-7）、
// 西/东门行（2-4 的两端列）与中心格（3,6）必须留空；任意门到任意门可通行。
// 战斗房按楼层主题权重抽取（pickLayoutTemplate），重进同房布局一致。
const ROOM_TEMPLATES = [
  // ── 岩石系（地窖/洞穴主力）──
  { name: "四角岩石", rows: [
    "RR.........RR",
    "RR.........RR",
    ".............",
    ".............",
    ".............",
    "RR.........RR",
    "RR.........RR",
  ] },
  { name: "中央岩环", rows: [
    ".............",
    "....RR.RR....",
    "....R...R....",
    "....R...R....",
    "....R...R....",
    "....RR.RR....",
    ".............",
  ] },
  { name: "斜线交叉", rows: [
    ".............",
    "..R.......R..",
    "...R.....R...",
    "....R...R....",
    "...R.....R...",
    "..R.......R..",
    ".............",
  ] },
  { name: "岩石栅道", rows: [
    ".............",
    ".............",
    ".RRR.R.R.RRR.",
    ".............",
    ".RRR.R.R.RRR.",
    ".............",
    ".............",
  ] },
  { name: "两侧岩壁", rows: [
    ".............",
    ".RRR.....RRR.",
    ".R.........R.",
    ".R.........R.",
    ".R.........R.",
    ".RRR.....RRR.",
    ".............",
  ] },
  { name: "四象限岩块", rows: [
    ".............",
    ".RR.......RR.",
    ".RR.......RR.",
    ".............",
    ".RR.......RR.",
    ".RR.......RR.",
    ".............",
  ] },
  { name: "岩石哨兵", rows: [
    ".............",
    "..R.......R..",
    ".............",
    "..R.......R..",
    ".............",
    "..R.......R..",
    ".............",
  ] },
  { name: "南北岩带", rows: [
    ".RRR.....RRR.",
    ".............",
    ".............",
    ".............",
    ".............",
    ".............",
    ".RRR.....RRR.",
  ] },
  // ── 柱子系 ──
  { name: "双柱对称", rows: [
    ".............",
    ".............",
    "...L.....L...",
    ".............",
    "...L.....L...",
    ".............",
    ".............",
  ] },
  { name: "四柱方阵", rows: [
    ".............",
    "..L.......L..",
    ".............",
    ".............",
    ".............",
    "..L.......L..",
    ".............",
  ] },
  { name: "柱廊大厅", rows: [
    ".............",
    ".............",
    "..L.......L..",
    "..L.......L..",
    "..L.......L..",
    ".............",
    ".............",
  ] },
  { name: "八方柱阵", rows: [
    ".............",
    ".............",
    ".....L.L.....",
    "....L...L....",
    ".....L.L.....",
    ".............",
    ".............",
  ] },
  // ── 便便系（地窖风味）──
  { name: "四角便便", rows: [
    "PP.........PP",
    "PP.........PP",
    ".............",
    ".............",
    ".............",
    "PP.........PP",
    "PP.........PP",
  ] },
  { name: "便便横排", rows: [
    ".............",
    ".............",
    ".............",
    "..PPPP.PPPP..",
    ".............",
    ".............",
    ".............",
  ] },
  { name: "便便钻石环", rows: [
    ".............",
    ".............",
    ".....P.P.....",
    "....P...P....",
    ".....P.P.....",
    ".............",
    ".............",
  ] },
  { name: "便便哨兵", rows: [
    ".............",
    ".............",
    "..P.......P..",
    ".............",
    "..P.......P..",
    ".............",
    ".............",
  ] },
  { name: "便便旷野", rows: [
    ".............",
    "..P.......P..",
    ".....P.P.....",
    ".............",
    ".....P.P.....",
    "..P.......P..",
    ".............",
  ] },
  // ── 火堆系 ──
  { name: "火堆守望", rows: [
    ".............",
    ".F.........F.",
    ".............",
    ".....R.R.....",
    ".............",
    ".F.........F.",
    ".............",
  ] },
  { name: "火堆岩阵", rows: [
    ".............",
    "..F.......F..",
    ".............",
    "....R...R....",
    ".............",
    "..F.......F..",
    ".............",
  ] },
  // ── 尖刺系（深处主力）──
  { name: "四角尖刺", rows: [
    "SS.........SS",
    "SS.........SS",
    ".............",
    ".............",
    ".............",
    "SS.........SS",
    "SS.........SS",
  ] },
  { name: "尖刺夹击", rows: [
    ".............",
    ".............",
    "....SS.SS....",
    ".............",
    "....SS.SS....",
    ".............",
    ".............",
  ] },
  { name: "尖刺竖栏", rows: [
    ".............",
    "...S.....S...",
    "...S.....S...",
    "...S.....S...",
    "...S.....S...",
    "...S.....S...",
    ".............",
  ] },
  // ── 混合系 ──
  { name: "地窖混合", rows: [
    ".............",
    "..R.......R..",
    ".............",
    ".PP.......PP.",
    ".............",
    "..R.......R..",
    ".............",
  ] },
  { name: "深处混合", rows: [
    ".............",
    ".L.........L.",
    ".............",
    "...S.....S...",
    ".............",
    ".L.........L.",
    ".............",
  ] },
  // ── 沟壑系（T=pit）──
  { name: "中央十字沟壑", rows: [
    ".............",
    "....T...T....",
    "....T...T....",
    "..TTT...TTT..",
    "....T...T....",
    "....T...T....",
    ".............",
  ] },
  { name: "双沟夹道", rows: [
    ".............",
    "..T.......T..",
    "..T..GGG..T..",
    "..T.......T..",
    "..T..GGG..T..",
    "..T.......T..",
    ".............",
  ] },
  { name: "沟壑铁堡", rows: [
    ".............",
    ".TTT.....TTT.",
    "..T..HHH..T..",
    ".............",
    "..T..HHH..T..",
    ".TTT.....TTT.",
    ".............",
  ] },
  // ── TNT 系（X=tnt）──
  { name: "TNT 四角岩阵", rows: [
    ".............",
    ".X.R.....R.X.",
    "..R.......R..",
    "....Y...Y....",
    "..R.......R..",
    ".X.R.....R.X.",
    ".............",
  ] },
  { name: "TNT 石环爆心", rows: [
    ".............",
    "....RR.RR....",
    "...R.....R...",
    "...R.X.X.R...",
    "...R.....R...",
    "....RR.RR....",
    ".............",
  ] },
  { name: "囊爆雷区", rows: [
    ".............",
    "..X.......X..",
    "...B.....B...",
    ".............",
    "...B.....B...",
    "..X.......X..",
    ".............",
  ] },
  { name: "雷桶哨柱", rows: [
    ".............",
    "..L..X.X..L..",
    ".............",
    "....X...X....",
    ".............",
    "..L..X.X..L..",
    ".............",
  ] },
  // ── 混合站位系（G crawler / H horf / Y fly / C charger / B boomFly / U host / N pooter / J hopper / W spider）──
  { name: "冲锋走廊", rows: [
    ".............",
    "..S.......S..",
    ".............",
    "..C.T...T.C..",
    ".............",
    "..S.......S..",
    ".............",
  ] },
  { name: "吐弹柱廊", rows: [
    ".............",
    "....L...L....",
    "..H.......H..",
    "....L...L....",
    "..H.......H..",
    "....L...L....",
    ".............",
  ] },
  // 原版地窖经典阵位：后排霍夫站桩吐弹、前排岩石当掩体（1F 开局房常见）
  { name: "岩盾霍夫", rows: [
    ".............",
    "..H.......H..",
    "..R.......R..",
    ".............",
    "..R.......R..",
    "..H.......H..",
    ".............",
  ] },
  // 龟壳哨位：上下 Host 站桩压制，尖刺封走位（2F 洞窟感）
  { name: "龟壳尖哨", rows: [
    ".............",
    "..S.......S..",
    ".............",
    ".U.........U.",
    ".............",
    "..S.......S..",
    ".............",
  ] },
  // 蛛巢沟壑：四角红蜘蛛游走，中央十字沟壑拦路（飞行怪可越）
  { name: "蛛巢沟壑", rows: [
    ".............",
    ".W.........W.",
    ".............",
    "...TT...TT...",
    ".............",
    ".W.........W.",
    ".............",
  ] },
  // 胖蚊绕桩：双柱之间胖蚊绕圈，便便点缀（1F 苍蝇主题）
  { name: "胖蚊绕桩", rows: [
    ".............",
    "...L.....L...",
    ".N..P...P..N.",
    ".............",
    ".N..P...P..N.",
    "...L.....L...",
    ".............",
  ] },
  // 跳蛙石滩：跳蛙踞四角石堆后，起跳可越石（1F 阵容）
  { name: "跳蛙石滩", rows: [
    ".............",
    "..J.......J..",
    "..R.......R..",
    ".............",
    "..R.......R..",
    "..J.......J..",
    ".............",
  ] },
];
// 模板字符表：R岩石 L柱子 P便便 F火堆 S尖刺 T沟壑 XTNT桶；
// 站位标记 G crawler / H horf / Y fly / C charger / B boomFly / U host / N pooter / J hopper / W spider
const TEMPLATE_KINDS = {
  R: "rock", L: "pillar", P: "pot", F: "candle", S: "spikes", T: "pit", X: "tnt",
  G: "crawler", H: "horf", Y: "fly", C: "charger", B: "boomFly",
  U: "host", N: "pooter", J: "hopper", W: "spider",
};
// 敌人站位标记字符集合（placeLayoutTemplate 不改地形、只记录出生点）
const TEMPLATE_ENEMY_MARKS = new Set(["G", "H", "Y", "C", "B", "U", "N", "J", "W"]);
const TEMPLATE_COLS = 13;
const TEMPLATE_ROWS = 7;

const FLOOR_ROMAN = ["I", "II", "III"];
// Boss 池：每层从对应池抽 1 只，一局内不重复（usedBossKinds 记录）；3 层终局固定妈腿
const BOSS_POOLS = {
  1: [{ kind: "monstro", name: "萌死戳·Kimi" }], // 一层必定 Kimi
  2: [
    { kind: "twins", name: "双子" },
    { kind: "gurdy", name: "古迪" },
    { kind: "dingle", name: "粪山" },
  ],
  3: [{ kind: "mom", name: "妈腿" }],
};
const BOSS_NAMES = { monstro: "萌死戳·Kimi", dingle: "粪山", twins: "双子", gurdy: "古迪", mom: "妈腿" };
// bossKind → 行为变体（ENEMY_HANDLERS.boss 按变体分派）与贴图
const BOSS_VARIANTS = { monstro: 1, twins: 2, mom: 3, dingle: 4, gurdy: 5 };
// 官方贴图：萌死戳三连帧取自官方游戏截图抠图（tools/extract-monstro.py，常态帧注册在此，
// 跳跃/狂暴由 setMonstroFace 换帧）；双子 = gemini.png 运行时裁半（geminiBig/geminiSmall）；
// 粪山/古迪用官方 boss 造型；5% 彩蛋时 monstro 改回 Kimi 蓝圆球（spawnEnemy 决定）
const BOSS_TEXTURES = { monstro: "monstroStand", twins: "geminiBig", dingle: "dingle", gurdy: "gurdy", mom: "momFoot" };
// Boss 显示尺寸（960×540 目标值，52px 格基准；参考 assets/ref/notes.md §2.2 校准）
// Boss 显示尺寸（v9 帧实测：monstro 趴姿 bbox 153 帧px×1.136≈174；双子大块头 98≈111）；
// dingle/gurdy/mom 无可用帧按原生×2 维持（妈腿显示尺寸在 variant 3 单独 fit 180）
const BOSS_SIZES = { monstro: 174, twins: 112, dingle: 110, gurdy: 130, mom: 170 };

// 药丸效果池：每局洗牌后按 pillId 固定映射，拾取时不知道效果，用后才揭晓（含坏效果）
const PILL_EFFECTS = [
  {
    name: "射程提升",
    apply: (scene) => {
      scene.playerStats.tearLife += 140;
      return "射程提升";
    },
  },
  {
    name: "射程下降",
    apply: (scene) => {
      scene.playerStats.tearLife = Math.max(420, scene.playerStats.tearLife - 160);
      return "射程下降……";
    },
  },
  {
    name: "攻速提升",
    apply: (scene) => {
      scene.playerStats.fireDelay = Math.max(120, Math.round(scene.playerStats.fireDelay * 0.85));
      return "攻速提升";
    },
  },
  {
    name: "伤害提升",
    apply: (scene) => {
      scene.playerStats.damage += 0.5;
      return "伤害提升";
    },
  },
  {
    name: "治疗",
    apply: (scene) => {
      if (scene.playerStats.hp >= scene.playerStats.maxHp) return "可你已经是满血了";
      scene.playerStats.hp = Math.min(scene.playerStats.maxHp, scene.playerStats.hp + 2); // 治疗 2 半心
      return "恢复了 1 颗红心";
    },
  },
  {
    name: "炸弹变钥匙",
    apply: (scene) => {
      const bombs = scene.playerStats.bombs;
      const keys = scene.playerStats.keys;
      scene.playerStats.bombs = keys + 2;
      scene.playerStats.keys = bombs + 2;
      return "炸弹和钥匙互换了（各 +2）";
    },
  },
  {
    name: "传送",
    apply: (scene) => {
      scene.teleportRandomRoom();
      return "被传送到了陌生的房间";
    },
  },
  {
    name: "魂心",
    apply: (scene) => {
      scene.playerStats.soulHp = Math.min(SOUL_HP_MAX, scene.playerStats.soulHp + 4); // 2 颗魂心
      return "获得 2 颗魂心";
    },
  },
];
const PILL_TINTS = [0xffffff, 0xff8a8a, 0x8aff8a, 0x8ab4ff, 0xffe08a, 0xd08aff, 0x8affe0, 0xff8ad0];

// 卡牌池：与药丸共用持有槽（Q 使用）
const CARD_POOL = [
  {
    id: "wheel",
    name: "命运之轮",
    tint: 0xd8a84a,
    apply: (scene) => {
      scene.teleportToRoomType("boss");
      return "命运之轮：你被卷向了 Boss 房";
    },
  },
  {
    id: "world",
    name: "世界",
    tint: 0x6db7ff,
    apply: (scene) => {
      scene.revealWholeMap();
      return "世界：整层的地图浮现在脑海中";
    },
  },
  {
    id: "emperor",
    name: "皇帝",
    tint: 0xd84a55,
    apply: (scene) => {
      const bonus = scene.playerStats.damage * 0.5;
      scene.emperorBoost += bonus;
      scene.playerStats.damage += bonus;
      return "皇帝：本层伤害提高 50%";
    },
  },
];

// 商店拾取物商品池（道具另按 45% 概率从 ITEM_POOL 抽，15¢）
// 定价对齐原版 wiki Shop：红心 3¢；钥匙/炸弹/电池/药丸/卡牌/魂心 5¢；Grab Bag 7¢ 未实现（本项目无口袋拾取物，不加）
const SHOP_OFFERS = [
  { kind: "heart", name: "红心", price: 3 },
  { kind: "key", name: "钥匙", price: 5 },
  { kind: "bomb", name: "炸弹", price: 5 },
  { kind: "battery", name: "电池", price: 5 },
  { kind: "pill", name: "药丸", price: 5 },
  { kind: "card", name: "卡牌", price: 5 },
  { kind: "soulHeart", name: "魂心", price: 5 },
];

// 普通隐藏房内装权重（原版 Secret Room 内容向，roll 2-3 组不放回）：
// coins=5-8 枚硬币堆 / boxKey=木箱+钥匙 / redChest=红箱 / souls=魂心×2 / item=道具底座
const HIDDEN_LOOT_TABLE = [
  ["coins", 40],
  ["boxKey", 20],
  ["redChest", 10],
  ["souls", 15],
  ["item", 15],
];

// 超级隐藏房内装权重（原版偏补给，roll 1-2 组不放回，永不出道具）：
// souls=魂心 1-2 颗 / pillcard=药丸+卡牌 / redChest=红箱 / bombs=炸弹×3
const SUPER_SECRET_LOOT_TABLE = [
  ["souls", 45],
  ["pillcard", 25],
  ["redChest", 15],
  ["bombs", 15],
];

// 隐藏房底座小池：原版 Secret Room 道具池偏"反隐形/增益"向；本项目 ITEM_POOL 没有魂心补给类
// 道具，取 6 件增益被动复用（藏宝图语义上最接近"揭示隐藏"），抽光后才回退全池
const SECRET_POOL = ["藏宝图", "光环", "幸运脚", "魔法蘑菇", "磁铁", "丘比特之箭"].map((name) =>
  ITEM_POOL.find((item) => item.name === name),
);

// 热路径复用的临时向量，避免 update 循环里每帧 new Vector2
const TMP_V1 = new Phaser.Math.Vector2();
const TMP_V2 = new Phaser.Math.Vector2();
const TMP_V3 = new Phaser.Math.Vector2();

// 敌人 AI 处理器表：kind → 每帧行为；crawler/bigSpider/sucker 等无表项的走 chase 直线追击。
// 签名统一为 (scene, enemy, time, toPlayer, distance, speedScale)，toPlayer 已归一化。
const ENEMY_HANDLERS = {
  chase(scene, enemy, time, toPlayer, distance, speedScale) {
    enemy.body.setVelocity(toPlayer.x * enemy.speed * speedScale, toPlayer.y * enemy.speed * speedScale);
  },
  // 霍夫 Horf：站桩漂浮头，每 1.4-2.2s 前摇闪白后朝玩家吐单发弹（原 spitter 的弹速，但钉在原地）
  horf(scene, enemy, time, toPlayer, distance, speedScale) {
    enemy.body.setVelocity(0, 0);
    scene.horfVolley(enemy, time, toPlayer);
  },
  // 龟壳 Host（真）：站桩缩壳无敌；每 2.5-3.5s 抬头露肉 900ms（可被打）并 ±20° 扇射 3 发
  host(scene, enemy, time, toPlayer, distance, speedScale) {
    enemy.body.setVelocity(0, 0);
    scene.hostShell(enemy, time, toPlayer);
  },
  // 胖蚊 Pooter：慢速绕玩家飘，不主动咬人（原版碰运气式走位）
  pooter(scene, enemy, time, toPlayer, distance, speedScale) {
    const radial = Phaser.Math.Clamp((distance - 190) / 140, -1, 1);
    const dir = enemy.uid % 2 ? 1 : -1; // 每只固定顺/逆时针，避免全堆在同一侧
    const tangent = TMP_V2.set(-toPlayer.y * dir, toPlayer.x * dir);
    const move = tangent.add(TMP_V3.copy(toPlayer).scale(radial * 0.85)).normalize().scale(enemy.speed * speedScale);
    enemy.body.setVelocity(move.x, move.y);
  },
  // 跳蛙 Hopper：待机 400-700ms 后朝玩家抛物线小跳（滞空可越障），落地挤压循环
  hopper(scene, enemy, time, toPlayer, distance, speedScale) {
    scene.updateHopper(enemy, time, toPlayer, distance);
  },
  // 红蜘蛛 Spider：中速追击 + 每 0.8-1.5s 随机 30° 抖向（比 crawler 飘得多）
  spider(scene, enemy, time, toPlayer, distance, speedScale) {
    if (time > (enemy.veerAt || 0)) {
      enemy.veerAt = time + scene.rng.between(800, 1500);
      enemy.veerAngle = (scene.rng.frac() * 2 - 1) * Phaser.Math.DegToRad(30);
    }
    const dir = TMP_V2.copy(toPlayer).rotate(enemy.veerAngle || 0);
    enemy.body.setVelocity(dir.x * enemy.speed * speedScale, dir.y * enemy.speed * speedScale);
  },
  // 爆蝇 BoomFly：与苍蝇同套环绕逼近 AI；死亡引线起爆见 damageEnemy 分支
  boomFly(scene, enemy, time, toPlayer, distance, speedScale) {
    ENEMY_HANDLERS.fly(scene, enemy, time, toPlayer, distance, speedScale);
  },
  // 自弃者 Mulligan：慢速逃向玩家对角线；贴近时每 3s 35% 概率点燃自爆（召 2 苍蝇）
  mulligan(scene, enemy, time, toPlayer, distance, speedScale) {
    scene.updateMulligan(enemy, time, toPlayer, distance, speedScale);
  },
  fly(scene, enemy, time, toPlayer, distance, speedScale) {
    const wobble = Math.sin(time / 240 + enemy.uid) * 0.6;
    const dir = TMP_V2.copy(toPlayer).rotate(wobble);
    const perp = TMP_V3.set(-dir.y, dir.x).scale(Math.sin(time / 150 + enemy.uid * 1.7) * 0.65);
    const move = dir.add(perp).normalize().scale(enemy.speed * speedScale);
    enemy.body.setVelocity(move.x, move.y);
  },
  charger(scene, enemy, time, toPlayer, distance, speedScale) {
    scene.updateCharger(enemy, time, toPlayer, distance, speedScale);
  },
  boss(scene, enemy, time, toPlayer, distance, speedScale) {
    if (enemy.bossVariant === 3) scene.updateBoss3(enemy, time);
    else if (enemy.bossVariant === 2) scene.updateBoss2(enemy, time, toPlayer, speedScale);
    else if (enemy.bossVariant === 4) scene.updateDingle(enemy, time, toPlayer, distance, speedScale);
    else if (enemy.bossVariant === 5) scene.updateGurdy(enemy, time, toPlayer);
    else scene.updateBoss1(enemy, time, toPlayer, distance, speedScale);
  },
  bossSmall(scene, enemy, time, toPlayer, distance, speedScale) {
    scene.updateBossSmall(enemy, time, toPlayer, speedScale);
  },
};

class BasementScene extends Phaser.Scene {
  constructor() {
    super("basement");
  }

  preload() {
    this.load.image("roomBackdrop", GAME_ASSETS.roomBackdrop);
    // 2F/3F 独立楼层皮肤（tools/make-floor-themes.py 从地窖底图派生）
    this.load.image("cavesRoom", GAME_ASSETS.cavesRoom);
    this.load.image("depthsRoom", GAME_ASSETS.depthsRoom);
    // 官方门贴图：drawDoors 按门状态选贴图（北向原图，程序旋转/翻转适配四向）
    this.load.image("doorOpen", GAME_ASSETS.doorOpen);
    this.load.image("bossDoor", GAME_ASSETS.bossDoor);
    this.load.image("devilDoor", GAME_ASSETS.devilDoor);
    this.load.image("secretRoomDoor", GAME_ASSETS.secretRoomDoor);
    this.load.image("treasureDoorLocked", GAME_ASSETS.treasureDoorLocked);
    // 官方渲染抠图的三层门洞（石门框+梯形黑隧道，北向原图）：tools/extract-doors.py
    this.load.image("doorHoleBasement", GAME_ASSETS.doorHoleBasement);
    this.load.image("doorHoleCaves", GAME_ASSETS.doorHoleCaves);
    this.load.image("doorHoleDepths", GAME_ASSETS.doorHoleDepths);
    // TNT 桶障碍 / 地窖款染色岩
    this.load.image("tnt", GAME_ASSETS.tnt);
    this.load.image("tintedRockTile", GAME_ASSETS.tintedRockTile);
    // 三层官方风沟壑：tools/make-floor-themes.py 按层地板色生成的 4 帧变体（placeObstacle 按 this.floor 选用）
    this.load.spritesheet("pitBasement", GAME_ASSETS.pitBasement, { frameWidth: 56, frameHeight: 56 });
    this.load.spritesheet("pitCaves", GAME_ASSETS.pitCaves, { frameWidth: 56, frameHeight: 56 });
    this.load.spritesheet("pitDepths", GAME_ASSETS.pitDepths, { frameWidth: 56, frameHeight: 56 });
    this.load.image("isaac", GAME_ASSETS.isaac);
    this.load.image("gaper", GAME_ASSETS.gaper);
    this.load.image("host", GAME_ASSETS.host);
    this.load.image("monstro", GAME_ASSETS.monstro);
    this.load.image("momFoot", GAME_ASSETS.momFoot); // 官方妈腿精灵（wiki 抓取）
    // 新怪官方贴图（wiki 抓取，见 assets/ref/sprite-manifest.md）
    this.load.image("horf", GAME_ASSETS.horf);
    this.load.image("pooter", GAME_ASSETS.pooter);
    this.load.image("spider", GAME_ASSETS.spider);
    this.load.image("bigSpider", GAME_ASSETS.bigSpider);
    this.load.image("mulligan", GAME_ASSETS.mulligan);
    this.load.image("boomFly", GAME_ASSETS.boomFly);
    this.load.image("sucker", GAME_ASSETS.sucker);
    this.load.image("hopper", GAME_ASSETS.hopper);
    // Boss 官方造型：萌死戳三连帧（tools/extract-monstro.py 从官方截图抠图）、双子连体整图、粪山、古迪
    this.load.image("monstroStand", GAME_ASSETS.monstroStand);
    this.load.image("monstroJump", GAME_ASSETS.monstroJump);
    this.load.image("monstroMad", GAME_ASSETS.monstroMad);
    this.load.image("gemini", GAME_ASSETS.gemini);
    this.load.image("dingle", GAME_ASSETS.dingle);
    this.load.image("gurdy", GAME_ASSETS.gurdy);
    // 官方蓝魂心（精英蓝色掉落、隐藏房补给等统一换用）
    this.load.image("soulHeart", GAME_ASSETS.soulHeart);
    // 官方吊挂店主（普通/特殊款）与红箱（隐藏房彩蛋与商品用）
    this.load.image("shopkeeper", GAME_ASSETS.shopkeeper);
    this.load.image("shopkeeperSpecial", GAME_ASSETS.shopkeeperSpecial);
    this.load.image("redChest", GAME_ASSETS.redChest);
    // 官方金箱/木箱（wiki.gg 抠图，像素风小图放大走程序 crisp 放大）；红箱沿用既有贴图
    this.load.image("goldChest", GAME_ASSETS.goldChest);
    this.load.image("woodChest", GAME_ASSETS.woodChest);
    // 官方小地图房型图标（9×8，paintMap 生成 crisp 放大纹理后按 tile 贴）
    this.load.image("shopIcon", GAME_ASSETS.shopIcon);
    this.load.image("treasureRoomIcon", GAME_ASSETS.treasureRoomIcon);
    this.load.image("bossRoomIcon", GAME_ASSETS.bossRoomIcon);
    this.load.image("secretRoomIcon", GAME_ASSETS.secretRoomIcon);
    this.load.image("superSecretRoomIcon", GAME_ASSETS.superSecretRoomIcon);
    this.load.image("redHeart", GAME_ASSETS.redHeart);
    this.load.image("penny", GAME_ASSETS.penny);
    this.load.image("key", GAME_ASSETS.key);
    this.load.image("bomb", GAME_ASSETS.bomb);
    this.load.image("pill", GAME_ASSETS.pill);
    this.load.image("poop", GAME_ASSETS.poop);
    this.load.image("spikes", GAME_ASSETS.spikes);
    this.load.image("pillars", GAME_ASSETS.pillars);
    // 柱子三碑楼层染色变体（tools/make-floor-themes.py tint_pillars 生成，原贴图深蓝灰进 1F 像贴错图）
    this.load.image("pillarBasement", GAME_ASSETS.pillarBasement);
    this.load.image("pillarCaves", GAME_ASSETS.pillarCaves);
    this.load.image("pillarDepths", GAME_ASSETS.pillarDepths);
    this.load.image("firePlace", GAME_ASSETS.firePlace);
    // 道具图标统一注册：GAME_ASSETS 里 item 前缀的 key 都是官方道具贴图（dataURI 直接加载）
    Object.keys(GAME_ASSETS).forEach((assetKey) => {
      if (assetKey.startsWith("item")) this.load.image(assetKey, GAME_ASSETS[assetKey]);
    });
    this.load.spritesheet("rocks", GAME_ASSETS.rocks, {
      frameWidth: 32,
      frameHeight: 32,
    });
  }

  create() {
    this.cameras.main.setBackgroundColor("#161312");
    this.makeTextures();
    this.makeMapIconTextures();
    this.sealRoomBackdrop();
    this.prepareMobTextures();
    this.keys = this.input.keyboard.addKeys({
      up: "W",
      down: "S",
      left: "A",
      right: "D",
      cup: "UP",
      cdown: "DOWN",
      cleft: "LEFT",
      cright: "RIGHT",
      restart: "R",
      action: "SPACE",
      bomb: "E",
      useHeld: "Q",
      pause: "ESC",
      pauseAlt: "P",
      map: "TAB",
      mute: "M",
    });
    this.input.keyboard.addCapture("TAB"); // 阻止 Tab 触发浏览器焦点切换

    this.touchTaps = Object.create(null); // 触屏一次性按键队列（主动/药丸/炸弹）
    this.setupTouchControls();

    this.input.keyboard.on("keydown", () => {
      SFX.ensure();
      MUSIC.start();
    });
    this.input.on("pointerdown", () => {
      SFX.ensure();
      MUSIC.start();
    });

    this.roomObjects = [];
    this.familiarSprites = [];
    this.placedBombs = [];
    this.shopkeepers = [];
    this.enemySeq = 0;
    this.stats = { kills: 0, items: 0, startedAt: this.time.now };

    // 调试 URL 参数：?seed=N 固定种子；?smoke=1 进房前先跑地图生成断言（runMapSmoke 隔离并恢复状态）
    const debugParams = new URLSearchParams(location.search);
    const seedParam = Number(debugParams.get("seed"));
    this.floor = 1;
    this.runSeed = Number.isFinite(seedParam) && seedParam > 0 ? Math.floor(seedParam) : Phaser.Math.Between(10000, 99999);
    this.rng = new Phaser.Math.RandomDataGenerator([`${this.runSeed}`]);
    this.seenItems = new Set(); // 目击道具：进房看见过的道具不再进抽取池（scene.restart 时随 create 清空）
    this.usedBossKinds = new Set(); // 本局已抽过的 Boss，保证每层 Boss 不重样
    this.shopDonated = 0; // 本局捐款机累计金额（每 5¢ 商店升 1 级；不写入存储，重开清零）
    this.donationCollider = null; // 捐款机与玩家的碰撞器（离开商店时随房间销毁并解绑）
    if (debugParams.get("smoke")) this.runMapSmoke();
    // ?floor=1..3 直接跳到指定楼层（截图/调试）
    const floorParam = Number(debugParams.get("floor"));
    if (floorParam >= 1 && floorParam <= MAX_FLOOR) this.floor = Math.floor(floorParam);
    this.rooms = this.buildMap();
    // 每局洗牌药丸效果映射：同种药丸（按颜色区分）在本局内效果固定
    this.pillDeck = PILL_EFFECTS.slice();
    for (let i = this.pillDeck.length - 1; i > 0; i -= 1) {
      const j = this.rng.between(0, i);
      [this.pillDeck[i], this.pillDeck[j]] = [this.pillDeck[j], this.pillDeck[i]];
    }
    this.identifiedPills = new Set();
    this.emperorBoost = 0; // 皇帝卡给的本层临时伤害，换层时移除
    this.pendingActiveDrop = null;
    this.current = { x: 0, y: 0 };
    this.activeRoomKey = "0,0";
    this.enteredRooms = new Set(["0,0"]);
    this.clearedRooms = new Set(["0,0"]);
    this.lastMoveAt = 0;
    this.invulnerableUntil = 0;
    this.fireAt = 0;
    this.statusTextAt = 0;
    this.gameEnded = false;
    this.isPaused = false;
    this.bigmapVisible = false;
    this.restartArmedAt = 0; // R 重开确认：第一次按后的 2 秒窗口
    this.runTimeMs = 0; // 游戏内累计时间（暂停/结算时不走），顶部计时显示用
    this.lastTimerSec = -1;
    this.bloodBanner = null; // 当前血带横幅（同时只保留一条）
    this.bloodLayer = null; // 本房血渍 decal 的合并 graphics，drawRoom 时重建
    this.bloodDecals = [];
    this.bloodFadeUntil = 0;
    this.wobActive = false; // 巴比伦娼妇增益当前是否生效（生命垂危时）

    this.playerStats = {
      hp: 6,
      maxHp: 6,
      speed: 190,
      damage: 1,
      fireDelay: 330,
      shots: 1,
      spread: 0,
      coins: 3,
      keys: 1,
      bombs: 2,
      tearSpeed: 430,
      tearLife: 780,
      tearScale: 1,
      rewardLuck: 0,
      activeItem: null,
      activeCharge: 0,
      activeChargeMax: 0,
      soulHp: 0,
      heldItem: null,
      piercing: 0,
      knockback: 1,
      magnet: false,
      mapReveal: false,
      lifesteal: 0,
      familiars: 0,
      chargeBonus: 0, // 电池：清房充能额外 +1
      whoreOfBabylon: false, // 巴比伦娼妇：生命垂危时增伤增速
    };

    this.tears = this.add.group(); // 泪弹走手动抛物线逻辑（updateTears），不参与物理
    this.enemyShots = this.physics.add.group();
    this.enemies = this.physics.add.group();
    this.pickups = this.physics.add.group();
    this.floorExits = this.physics.add.group();
    this.obstacles = this.physics.add.staticGroup();
    this.obstacleZones = [];

    this.player = this.physics.add.sprite(ROOM.cx, ROOM.cy, SPRITES.player);
    this.player.setDepth(DEPTH.actor);
    // 原版比例（notes §0）：以撒 ≈52×60 目标像素（判定圈源帧坐标，随贴图等比缩放）
    this.player.setDisplaySize(52, 60);
    this.player.setCircle(12, 2, 8);
    this.player.setCollideWorldBounds(false);
    this.player.stats = this.playerStats;
    this.playerBaseScaleX = this.player.scaleX; // 走路 squash 动画的基准缩放
    this.playerBaseScaleY = this.player.scaleY;
    this.walkTween = null;

    this.physics.add.overlap(this.player, this.enemies, this.touchEnemy, null, this);
    this.physics.add.overlap(this.player, this.enemyShots, this.hitByShot, null, this);
    this.physics.add.overlap(this.player, this.pickups, this.collectPickup, null, this);
    this.physics.add.overlap(this.player, this.floorExits, this.enterFloorExit, null, this);
    this.physics.add.collider(this.player, this.obstacles, this.touchObstacle, null, this);
    // 飞行怪（苍蝇/胖蚊/爆蝇）与滞空跳蛙越过障碍，其余小怪被撞挡下
    this.physics.add.collider(
      this.enemies,
      this.obstacles,
      null,
      (enemy) => !(ENEMY_FLYING.has(enemy.kind) || (enemy.kind === "hopper" && enemy.state === "hop")),
      this,
    );
    this.physics.add.collider(this.enemyShots, this.obstacles, this.projectileHitObstacle, null, this);

    this.buildHud();
    this.drawRoom();
    this.updateHud();
    this.applyDebugParams();
    // 冒烟·怪物行为模拟需玩家/房间就位：create 完成后 150ms 跑（runMapSmoke 只断言静态表）
    if (debugParams.get("smoke")) this.time.delayedCall(150, () => this.smokeEnemySim());
    this.showToast("WASD 移动，方向键射击，空格主动，E 炸弹，Q 药丸，Tab 地图，Esc 暂停，M 静音");
  }

  makeTextures() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });

    g.clear();
    g.fillStyle(0x4ea1bd, 0.35);
    g.fillCircle(8, 8, 8);
    g.fillStyle(0xa8d8e8, 1);
    g.fillCircle(8, 8, 7);
    g.fillStyle(0xf4fbff, 0.72);
    g.fillCircle(6, 5, 2);
    g.generateTexture("tear", 16, 16);

    // 小怪普通弹（enemyFire 默认）：原版即血色小弹（ref f_0106），与 Boss 加大红弹同源，
    // 只是尺寸小——深红外圈 + 血红（#c0392b）主体 + 白心高光
    g.clear();
    g.fillStyle(0x8f2a20, 0.5);
    g.fillCircle(7, 7, 6.5);
    g.fillStyle(0xc0392b, 1);
    g.fillCircle(7, 7, 5.5);
    g.fillStyle(0xf7e8e2, 0.9);
    g.fillCircle(5.5, 4.8, 1.8);
    g.generateTexture("enemyShotSmall", 14, 14);

    // Boss 级血弹（enemyFire red 选项）：外圈深红 + 暗红核 + 高光，原版 Boss 弹幕印象色
    g.clear();
    g.fillStyle(0x8f2a20, 0.5);
    g.fillCircle(11, 11, 10.5);
    g.fillStyle(0xc0392b, 1);
    g.fillCircle(11, 11, 9.5);
    g.fillStyle(0xe06a58, 1);
    g.fillEllipse(8.5, 7.5, 8, 6);
    g.fillStyle(0xf7c9bd, 0.85);
    g.fillCircle(7.5, 6.5, 2);
    g.generateTexture("enemyShotRed", 22, 22);

    g.clear();
    g.fillStyle(0x140f10, 0.38);
    g.fillEllipse(38, 44, 70, 18);
    g.fillStyle(0x6f513b, 1);
    g.fillRoundedRect(8, 9, 60, 38, 10);
    g.fillStyle(0x9e7552, 1);
    g.fillRoundedRect(13, 7, 50, 28, 9);
    g.lineStyle(4, 0xf1d08b, 0.9);
    g.strokeRoundedRect(8, 9, 60, 38, 10);
    g.lineStyle(3, 0x4b3428, 0.8);
    g.lineBetween(21, 15, 21, 39);
    g.lineBetween(38, 11, 38, 45);
    g.lineBetween(55, 15, 55, 39);
    g.generateTexture("floorExit", 76, 58);

    g.clear();
    g.fillStyle(0x101010, 0.3);
    g.fillEllipse(14, 19, 22, 7);
    g.fillStyle(0xcfd6da, 0.55);
    g.fillEllipse(9, 8, 12, 8);
    g.fillEllipse(19, 8, 12, 8);
    g.fillStyle(0x3a3f45, 1);
    g.fillCircle(14, 14, 7);
    g.fillStyle(0xd84545, 1);
    g.fillCircle(11, 12, 1.8);
    g.fillCircle(17, 12, 1.8);
    g.generateTexture("fly", 28, 24);

    g.clear();
    g.fillStyle(0x120d0d, 0.35);
    g.fillEllipse(22, 30, 36, 10);
    g.fillStyle(0x8a4a3a, 1);
    g.fillCircle(22, 18, 15);
    g.fillStyle(0xd8cfc0, 1);
    g.fillTriangle(9, 10, 14, 2, 16, 12);
    g.fillTriangle(35, 10, 30, 2, 28, 12);
    g.fillStyle(0x2a1210, 1);
    g.fillCircle(16, 16, 2.6);
    g.fillCircle(28, 16, 2.6);
    g.fillStyle(0x5a241c, 1);
    g.fillRoundedRect(14, 24, 16, 4, 2);
    g.generateTexture("charger", 44, 36);

    g.clear();
    g.fillStyle(0x6a4a9a, 1);
    g.fillCircle(13, 13, 10);
    g.fillStyle(0x8a5fbf, 1);
    g.fillEllipse(13, 10, 15, 10);
    g.fillStyle(0x2a1a3a, 1);
    g.fillCircle(9, 12, 2);
    g.fillCircle(17, 12, 2);
    g.fillStyle(0xd8cfc0, 1);
    g.fillTriangle(5, 6, 8, 0, 10, 7);
    g.fillTriangle(21, 6, 18, 0, 16, 7);
    g.generateTexture("familiar", 26, 26);

    // 捐款机（原版商店北墙常客）：灰铁圆角机箱 + 深色显示屏 + 下方投币口含一枚金币；
    // 交互见 spawnShop/touchDonationMachine（走近自动捐 1¢，每 5¢ 商店升 1 级）
    g.clear();
    g.fillStyle(0x101010, 0.35);
    g.fillEllipse(25, 46, 44, 9);
    g.fillStyle(0x5f646a, 1);
    g.fillRoundedRect(6, 6, 38, 40, 7);
    g.fillStyle(0x848a90, 1);
    g.fillRoundedRect(9, 7, 32, 30, 6);
    g.fillStyle(0x2a2f34, 1); // 显示屏
    g.fillRoundedRect(14, 11, 22, 12, 3);
    g.fillStyle(0x9fd8e8, 0.85); // 屏显余光
    g.fillRect(17, 14, 16, 3);
    g.fillStyle(0x2a2f34, 1); // 投币口
    g.fillRoundedRect(21, 27, 8, 10, 2);
    g.fillStyle(0xd8b23a, 1); // 嵌在口里的金币
    g.fillRect(23, 29, 4, 4);
    g.generateTexture("donation", 50, 52);

    g.clear();
    g.fillStyle(0x101010, 0.3);
    g.fillEllipse(16, 34, 26, 7);
    g.fillStyle(0x3a3f45, 1);
    g.fillRoundedRect(6, 8, 20, 24, 4);
    g.fillStyle(0xd8b96a, 1);
    g.fillRoundedRect(12, 2, 8, 7, 2);
    g.fillStyle(0x6db7ff, 1);
    g.fillTriangle(17, 11, 11, 20, 15, 20);
    g.fillTriangle(15, 19, 21, 28, 13, 28);
    g.generateTexture("battery", 32, 40);

    g.clear();
    g.fillStyle(0x101010, 0.3);
    g.fillEllipse(16, 36, 24, 6);
    g.fillStyle(0xf0e8d8, 1);
    g.fillRoundedRect(4, 2, 24, 32, 4);
    g.lineStyle(2, 0x8a6a45, 1);
    g.strokeRoundedRect(6, 4, 20, 28, 3);
    g.fillStyle(0x8a4a3a, 1);
    g.fillCircle(16, 18, 5);
    g.generateTexture("card", 32, 40);

    // 木箱/金箱不再程序绘：官方贴图（preload 的 woodChest/goldChest）

    // Kimi 月亮吉祥物风的 1 层 Boss：圆脸弯月 Q 版（圆月脸 + 弯月高光 + 大眼微笑）。
    // imagegen 不可用时的程序化绘制版；100x100，脸半径 42（判定圈 0.42 与脸缘对齐）
    g.clear();
    // Kimi 蓝圆球家族（官方吉祥物：蓝色绒球）：base 闭眼常态 / wake 睁眼攻击 / jump 腾空挤眼 / mad 狂暴怒眉
    const drawKimiBall = (key, face) => {
      g.clear();
      const mad = face === "mad";
      g.fillStyle(0x140f10, 0.35);
      g.fillEllipse(50, 90, 62, 11); // 地面投影
      g.fillStyle(mad ? 0x8f9df5 : 0x8fb8f5, 0.12); // 外围淡蓝光晕（两层叠出柔和感）
      g.fillCircle(50, 48, 48);
      g.fillStyle(mad ? 0x8f9df5 : 0x8fb8f5, 0.16);
      g.fillCircle(50, 48, 45);
      g.fillStyle(mad ? 0x7a7ae0 : 0x7aa5ec, 1); // 球体底色（下缘偏深）
      g.fillCircle(50, 48, 40);
      g.fillStyle(mad ? 0x9494ea : 0x93bdf3, 1); // 中部叠色
      g.fillCircle(50, 44, 37);
      g.fillStyle(mad ? 0xb2b2f2 : 0xa9cdf8, 0.9); // 上部受光
      g.fillCircle(50, 38, 30);
      g.fillStyle(0xd6e7fd, 0.75); // 左上柔和高光斑
      g.fillEllipse(36, 26, 22, 13);
      g.fillStyle(0xffffff, 0.5);
      g.fillEllipse(33, 23, 10, 6);
      if (face === "base") {
        g.fillStyle(0xffffff, 0.96); // 闭眼 — —
        g.fillRoundedRect(28, 46, 15, 5.5, 2.75);
        g.fillRoundedRect(58, 46, 15, 5.5, 2.75);
      } else if (face === "wake") {
        g.fillStyle(0x24447f, 1); // 睁眼（深蓝圆眼+高光）
        g.fillCircle(36, 47, 6);
        g.fillCircle(65, 47, 6);
        g.fillStyle(0xffffff, 0.95);
        g.fillCircle(34, 45, 2);
        g.fillCircle(63, 45, 2);
        g.lineStyle(2.6, 0x24447f, 1); // 微笑
        g.beginPath();
        g.arc(50, 52, 9, Phaser.Math.DegToRad(35), Phaser.Math.DegToRad(145));
        g.strokePath();
      } else if (face === "jump") {
        g.lineStyle(3.4, 0xffffff, 0.96); // 挤眼 > <
        g.beginPath();
        g.moveTo(29, 42);
        g.lineTo(40, 48);
        g.lineTo(29, 54);
        g.moveTo(72, 42);
        g.lineTo(61, 48);
        g.lineTo(72, 54);
        g.strokePath();
        g.fillStyle(0x24447f, 1); // 张嘴
        g.fillEllipse(50, 63, 15, 12);
        g.fillStyle(0x7fa8e8, 1);
        g.fillEllipse(50, 66, 9, 6);
      } else if (face === "mad") {
        g.lineStyle(4, 0x2a3f78, 1); // 怒眉
        g.beginPath();
        g.moveTo(27, 38);
        g.lineTo(43, 44);
        g.moveTo(74, 38);
        g.lineTo(58, 44);
        g.strokePath();
        g.fillStyle(0xffffff, 0.96); // 半闭眼横条
        g.fillRoundedRect(29, 48, 15, 5, 2.5);
        g.fillRoundedRect(57, 48, 15, 5, 2.5);
        g.lineStyle(2.8, 0x2a3f78, 1); // 下撇嘴
        g.beginPath();
        g.arc(50, 68, 9, Phaser.Math.DegToRad(215), Phaser.Math.DegToRad(325));
        g.strokePath();
      }
      g.generateTexture(key, 100, 100);
    };
    drawKimiBall("kimiBoss", "base");
    drawKimiBall("kimiBossWake", "wake");
    drawKimiBall("kimiBossJump", "jump");
    drawKimiBall("kimiBossMad", "mad");

    g.destroy();
  }

  // 三张楼层底图（地窖/洞穴/深处）自 v9 起即全密封墙（make-floor-themes.py 不再烘焙门洞；
  // 门由 drawDoors 按槽位放官方门洞贴图）。sealed 直通拷贝保留 outKey，
  // 兼容 roomBackdropKey/bigRoomBackdropKey 与 1×1 回归断言。
  sealRoomBackdrop() {
    this.sealOneBackdrop("roomBackdrop", "roomSealed");
    this.sealOneBackdrop("cavesRoom", "roomSealed2");
    this.sealOneBackdrop("depthsRoom", "roomSealed3");
  }

  // 当前楼层的 sealed 底图 key（drawRoom 按层选图，不再整图 tint 骗楼层主题）
  roomBackdropKey() {
    if (this.floor === 2) return "roomSealed2";
    if (this.floor >= 3) return "roomSealed3";
    return "roomSealed";
  }

  // 多尺寸房底图：不打新图包，运行时从本层 sealed 纹理（960×540，门洞已全部修补）
  // 拷贝拼出 w×h 单元的大尺寸纹理——地板/墙带逐单元镜像平铺（镜像让跨缝两侧同源连续），
  // 四角原样拷贝；全图无门洞（各槽位是否开门由 drawDoors 的门贴图/开门态后期覆盖）。
  // 1×1 直接回本层 sealed key（像素级原样，保回归）。结果按 roomSealed_{floor}_{w}x{h} 缓存。
  bigRoomBackdropKey(room) {
    const w = (room && room.w) || 1;
    const h = (room && room.h) || 1;
    if (w === 1 && h === 1) return this.roomBackdropKey();
    const key = `roomSealed_${this.floor}_${w}x${h}`;
    if (this.textures.exists(key)) return key;
    const src = this.textures.get(this.roomBackdropKey()).getSourceImage();
    const worldW = WALL_X + CELL_W * w + WALL_X;
    const worldH = WALL_Y + CELL_H * h + WALL_Y;
    const canvas = document.createElement("canvas");
    canvas.width = worldW;
    canvas.height = worldH;
    const ctx = canvas.getContext("2d");
    // 用 sw×sh 源块（逐块镜像，镜像让跨缝两侧同源连续）铺满目标矩形；边缘部分块裁切。
    // 注意源块自身不得含贴墙阴影/探出的墙梁——否则接缝处会翻倍出黑带（v7 踩过坑）
    const tileFill = (sx, sy, sw, sh, dx0, dy0, dw, dh) => {
      for (let x = dx0, i = 0; x < dx0 + dw; x += sw, i += 1) {
        const wRem = Math.min(sw, dx0 + dw - x);
        for (let y = dy0, j = 0; y < dy0 + dh; y += sh, j += 1) {
          const hRem = Math.min(sh, dy0 + dh - y);
          const fx = i % 2 === 1;
          const fy = j % 2 === 1;
          const srcX = fx ? sx + sw - wRem : sx;
          const srcY = fy ? sy + sh - hRem : sy;
          ctx.save();
          ctx.translate(x + (fx ? wRem : 0), y + (fy ? hRem : 0));
          ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
          ctx.drawImage(src, srcX, srcY, wRem, hRem, 0, 0, wRem, hRem);
          ctx.restore();
        }
      }
    };
    // 地板：内芯（去掉四面贴墙阴影/梁尖 S px）镜像平铺全地板区；
    // 四条贴墙阴影带（含梁尖）只铺房间外缘，接缝处同源连续
    const S = 32;
    const iw = CELL_W - S * 2;
    const ih = CELL_H - S * 2;
    tileFill(ROOM.left + S, ROOM.top + S, iw, ih, ROOM.left, ROOM.top, CELL_W * w, CELL_H * h);
    const floorRight = ROOM.left + CELL_W * w;
    const floorBottom = ROOM.top + CELL_H * h;
    tileFill(ROOM.left, ROOM.top, CELL_W, S, ROOM.left, ROOM.top, CELL_W * w, S); // 上缘阴影带
    tileFill(ROOM.left, ROOM.bottom - S, CELL_W, S, ROOM.left, floorBottom - S, CELL_W * w, S); // 下缘
    tileFill(ROOM.left, ROOM.top, S, CELL_H, ROOM.left, ROOM.top, S, CELL_H * h); // 左缘
    tileFill(ROOM.right - S, ROOM.top, S, CELL_H, floorRight - S, ROOM.top, S, CELL_H * h); // 右缘
    // 顶/底墙带（含墙面与梁）按单元横铺；左/右墙带按单元竖铺（墙带内无阴影边问题）
    tileFill(ROOM.left, 0, CELL_W, WALL_Y, ROOM.left, 0, CELL_W * w, WALL_Y);
    tileFill(ROOM.left, ROOM.bottom, CELL_W, WALL_Y, ROOM.left, floorBottom, CELL_W * w, WALL_Y);
    tileFill(0, ROOM.top, WALL_X, CELL_H, 0, ROOM.top, WALL_X, CELL_H * h);
    tileFill(ROOM.right, ROOM.top, WALL_X, CELL_H, floorRight, ROOM.top, WALL_X, CELL_H * h);
    // 四角：1×1 纹理四角原样落位
    ctx.drawImage(src, 0, 0, WALL_X, WALL_Y, 0, 0, WALL_X, WALL_Y);
    ctx.drawImage(src, ROOM.right, 0, WALL_X, WALL_Y, floorRight, 0, WALL_X, WALL_Y);
    ctx.drawImage(src, 0, ROOM.bottom, WALL_X, WALL_Y, 0, floorBottom, WALL_X, WALL_Y);
    ctx.drawImage(src, ROOM.right, ROOM.bottom, WALL_X, WALL_Y, floorRight, floorBottom, WALL_X, WALL_Y);
    this.textures.addCanvas(key, canvas);
    return key;
  }

  // 新怪贴图预处理（create 阶段一次）：
  // 1) gemini.png（57×50 连体整图）按官方包围盒裁成 geminiBig/geminiSmall 两半；
  // 2) 小怪贴图统一加地面投影 + 深色描边（sucker/pooter 等小图在 960×540 下太薄，垫影子才读得出）。
  prepareMobTextures() {
    this.makeGeminiTextures();
    [
      "horf", "pooter", "spider", "bigSpider", "mulligan", "boomFly", "sucker", "hopper", "host",
      "geminiBig", "geminiSmall", "dingle", "gurdy",
    ].forEach((key) => this.enhanceMobTexture(key));
  }

  // 双子分体：官方只存连体图（57×50：右半露齿狞笑是大体 Contusion，左半哭脸+血链节是小体 Suture，
  // manifest 的左右包围盒注释与实际相反，以目检为准），按实测包围盒裁两帧
  makeGeminiTextures() {
    const src = this.textures.get("gemini").getSourceImage();
    [["geminiBig", 26, 8, 31, 42], ["geminiSmall", 0, 0, 26, 44]].forEach(([key, sx, sy, w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, sx, sy, w, h, 0, 0, w, h);
      if (this.textures.exists(key)) this.textures.remove(key);
      this.textures.addCanvas(key, canvas);
    });
  }

  // 单张贴图增强：底部垫暗椭圆地面投影 + 8 向黑剪影描边（ctx.filter 可用时），原地替换同名 key。
  // 贴图整体上移 2px 给影子留位；判定圈/spawnEnemy 的尺寸换算在此之后发生，不受影响。
  enhanceMobTexture(key) {
    if (!this.textures.exists(key)) return;
    const src = this.textures.get(key).getSourceImage();
    const padX = 4;
    const padTop = 4;
    const padBottom = 10;
    const w = src.width + padX * 2;
    const h = src.height + padTop + padBottom;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    // 地面投影：贴图底缘正下方的暗椭圆（原版小怪都有地面影）
    ctx.fillStyle = "rgba(12,8,7,0.34)";
    ctx.beginPath();
    ctx.ellipse(padX + src.width / 2, padTop + src.height + padBottom / 2 - 3, src.width * 0.42, padBottom * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    // 8 向黑色剪影垫出可读轮廓（1.6px 偏移）
    if (typeof ctx.filter === "string") {
      ctx.filter = "brightness(0) opacity(80%)";
      for (let i = 0; i < 8; i += 1) {
        const angle = (Math.PI * 2 * i) / 8;
        ctx.drawImage(src, padX + Math.cos(angle) * 1.6, padTop - 2 + Math.sin(angle) * 1.6);
      }
      ctx.filter = "none";
    }
    ctx.drawImage(src, padX, padTop - 2);
    this.textures.remove(key);
    this.textures.addCanvas(key, canvas);
  }

  sealOneBackdrop(srcKey, outKey) {
    const src = this.textures.get(srcKey).getSourceImage();
    const tex = this.textures.createCanvas(outKey, WIDTH, HEIGHT);
    const ctx = tex.getContext();
    ctx.drawImage(src, 0, 0, WIDTH, HEIGHT);
    tex.refresh();
  }

  buildMap() {
    // 随机游走 + 补死胡同一次成型；形状不合格（补完仍 <4 个死胡同）就整层重摇（原版即重试直到形状可用）
    let grown = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      grown = this.growFloorRooms();
      if (grown.ends >= 4) break;
    }
    const { rooms, path } = grown;

    const list = () => [...rooms.values()];
    const dist = (room) => Math.abs(room.x) + Math.abs(room.y);
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    const neighborCount = (rx, ry) =>
      dirs.reduce((n, d) => n + (rooms.has(`${rx + d.x},${ry + d.y}`) ? 1 : 0), 0);
    const candidates = list().filter((room) => room.x !== 0 || room.y !== 0);
    const ends = list().filter((room) => (room.x !== 0 || room.y !== 0) && neighborCount(room.x, room.y) === 1);
    const byDistDesc = (a, b) => dist(b) - dist(a);

    // Boss 房 = 离起点最远的死胡同（兜底：最远普通房）；Boss 池一局不重复，重进同房 bossKind 不变
    const boss = (ends.length ? ends : candidates).slice().sort(byDistDesc)[0];
    if (boss) {
      boss.type = "boss";
      const floorPool = BOSS_POOLS[Math.min(this.floor, MAX_FLOOR)];
      const fresh = floorPool.filter((entry) => !this.usedBossKinds.has(entry.kind));
      // ?boss=kind：仅调试用，强制本层 Boss 种类（截图/冒烟指定阵容）
      const bossParam = new URLSearchParams(location.search).get("boss");
      const forced = bossParam ? floorPool.find((entry) => entry.kind === bossParam) : null;
      const picked = forced || this.rng.pick(fresh.length ? fresh : floorPool);
      boss.bossKind = picked.kind;
      this.usedBossKinds.add(picked.kind);
    }

    // 宝箱房 = 另一个距离 ≥2 的死胡同（兜底：任意距离 ≥2 房）
    const treasure =
      ends.filter((room) => room !== boss && dist(room) >= 2).sort(byDistDesc)[0] ||
      candidates.filter((room) => room !== boss && dist(room) >= 2).sort(byDistDesc)[0];
    if (treasure) {
      treasure.type = "treasure";
      treasure.cleared = true;
      treasure.unlocked = this.floor === 1;
    }

    // 商店 = 优先死胡同（兜底：任意余量房）；2 层起要钥匙（isDoorLocked 与宝箱房同规则）
    const shop =
      ends.filter((room) => room !== boss && room !== treasure).sort(byDistDesc)[0] ||
      candidates.filter((room) => room !== boss && room !== treasure)[0];
    if (shop) {
      shop.type = "shop";
      shop.cleared = true;
      shop.unlocked = this.floor === 1;
    }

    // 合并步骤（原版多尺寸房）：只合并 combat 房，特殊房一律 1×1；
    // 先于隐藏房选址，隐藏房邻居统计按合并后的房对象去重（大房只算 1 个邻居）
    // ?nomerge=1 调试开关：跳过合并，隔离排查地图拓扑问题
    if (!new URLSearchParams(location.search).get("nomerge")) this.mergeCombatRooms(rooms);
    this.addHiddenRoom(rooms);

    path.forEach((room) => {
      const current = rooms.get(`${room.x},${room.y}`);
      if (current) current.onMainPath = true;
    });

    return rooms;
  }

  // 原版多尺寸房合并：随机把相邻两个 combat 房合成 1×2/2×1（锚点=左上格，w/h 记尺寸，
  // cells 记全部占格，地图每个被占格键都映射到同一房对象）；每层目标 2-4 个双格大房，
  // 另 ≤1 个 2×2 四格大房（找不到合格方块就放弃）。?big=1x2,2x1,2x2 调试参数强制至少各一个。
  mergeCombatRooms(rooms) {
    const key = (x, y) => `${x},${y}`;
    // 度数按房对象去重（当前普通房图内邻居房数）：死胡同房绝不合并——哪怕它的唯一邻居
    // 是已合并大房、两格键都与它相邻（key 级度数会误判为 2）；合并两端后邻居并集 <2 的也不合并，
    // 保证合并前后死胡同房集合不变，Boss/宝箱/商店选址与死胡同断言口径不受合并影响
    const deg = (x, y) => {
      const set = new Set();
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const r = rooms.get(key(x + dx, y + dy));
        if (r) set.add(r);
      });
      return set.size;
    };
    const unionNbrs = (cellsArr) => {
      const own = new Set(cellsArr.map((c) => key(c.x, c.y)));
      const set = new Set();
      cellsArr.forEach((c) =>
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const k = key(c.x + dx, c.y + dy);
          // 按房对象去重：与已合并大房多格相邻只算 1 个邻居——保证合并不制造/不吞掉死胡同
          if (rooms.has(k) && !own.has(k)) set.add(rooms.get(k));
        }),
      );
      return set;
    };
    const isCombat = (x, y) => {
      const r = rooms.get(key(x, y));
      return Boolean(r) && r.type === "combat" && (r.w || 1) === 1 && (r.h || 1) === 1;
    };
    const merge = (cells, w, h) => {
      const anchor = cells.reduce((a, c) => (c.y < a.y || (c.y === a.y && c.x < a.x) ? c : a));
      const room = rooms.get(key(anchor.x, anchor.y));
      room.w = w;
      room.h = h;
      room.cells = cells.map((c) => ({ x: c.x, y: c.y }));
      cells.forEach((c) => rooms.set(key(c.x, c.y), room));
      return room;
    };
    const want = (new URLSearchParams(location.search).get("big") || "").split(",").filter(Boolean);

    // 2×2 方块合并：≤1 次；原生抽到合格方块约一半概率采用，控制出现频次
    const quads = [];
    rooms.forEach((room) => {
      const { x, y } = room;
      const quadCells = [{ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
      if (quadCells.every((c) => isCombat(c.x, c.y) && deg(c.x, c.y) >= 2) && unionNbrs(quadCells).size >= 2) {
        if (!quads.some((q) => q.x === x && q.y === y)) quads.push({ x, y });
      }
    });
    if (quads.length && (want.includes("2x2") || this.rng.frac() < 0.55)) {
      const q = this.rng.pick(quads);
      merge([{ x: q.x, y: q.y }, { x: q.x + 1, y: q.y }, { x: q.x, y: q.y + 1 }, { x: q.x + 1, y: q.y + 1 }], 2, 2);
    }

    // 双格合并：wantW=2 横向 1×2 / 1 竖向 2×1 / null 随机朝向；东/南取邻保证锚点是左上格
    const tryMergeAt = (c, wantW) => {
      const order = wantW === 2 ? [[1, 0]] : wantW === 1 ? [[0, 1]] : this.rng.shuffle([[1, 0], [0, 1]]);
      for (const [dx, dy] of order) {
        const pair = [{ x: c.x, y: c.y }, { x: c.x + dx, y: c.y + dy }];
        if (pair.every((p) => isCombat(p.x, p.y) && deg(p.x, p.y) >= 2) && unionNbrs(pair).size >= 2) {
          merge(pair, dx ? 2 : 1, dx ? 1 : 2);
          return true;
        }
      }
      return false;
    };
    const cells = [...new Set(rooms.values())]
      .filter((room) => room.type === "combat")
      .map((room) => ({ x: room.x, y: room.y }));
    ["1x2", "2x1"].forEach((shape) => {
      if (!want.includes(shape)) return;
      for (const c of this.rng.shuffle(cells.slice())) {
        if (tryMergeAt(c, shape === "1x2" ? 2 : 1)) return;
      }
    });
    // 两遍走：第一遍保底约两个，第二遍按 ~30% 参与率补到目标数（目标 2-4 个双格大房）
    const target = 2 + this.rng.between(0, 2);
    let count = 0;
    const shuffled = this.rng.shuffle(cells.slice());
    for (const c of shuffled) {
      if (count >= 2) break;
      if (tryMergeAt(c, null)) count += 1;
    }
    for (const c of shuffled) {
      if (count >= target) break;
      if (this.rng.frac() < 0.35 && tryMergeAt(c, null)) count += 1;
    }
  }

  // 生成一层普通房（随机游走凑数 → 补死胡同），返回 { rooms, path, ends }；
  // ends 为补完后的死胡同数，buildMap 据此决定是否整层重摇
  growFloorRooms() {
    const rooms = new Map();
    const put = (x, y, data = {}) => {
      rooms.set(`${x},${y}`, {
        x,
        y,
        type: "combat",
        cleared: false,
        visited: false,
        itemTaken: false,
        unlocked: false,
        revealed: true,
        looted: false,
        ...data,
      });
    };
    put(0, 0, { type: "start", cleared: true, unlocked: true });

    let x = 0;
    let y = 0;
    const path = [{ x, y }];
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    const inBounds = (px, py) => Math.abs(px) <= 3 && Math.abs(py) <= 3;
    const neighborCount = (rx, ry) =>
      dirs.reduce((n, d) => n + (rooms.has(`${rx + d.x},${ry + d.y}`) ? 1 : 0), 0);
    const list = () => [...rooms.values()];
    // 死胡同：只有 1 个邻居的普通房间
    const deadEnds = () => list().filter((room) => neighborCount(room.x, room.y) === 1);

    // 原版公式：6 + (0 或 1) + 层数×3 个房间（1F≈9-10 / 2F≈12-13 / 3F≈15-16，封顶 18），随机游走直到凑够
    const targetCount = Math.min(18, 6 + this.rng.between(0, 1) + this.floor * 3);
    let attempts = 0;
    while (rooms.size < targetCount && attempts < 600) {
      attempts += 1;
      const d = this.rng.pick(dirs);
      x = Phaser.Math.Clamp(x + d.x, -3, 3);
      y = Phaser.Math.Clamp(y + d.y, -3, 3);
      if (!rooms.has(`${x},${y}`)) {
        put(x, y);
        path.push({ x, y });
      }
    }

    // 原版楼层依赖死胡同布置特殊房：不足 4 个时，在多邻房间旁补新叶房
    // （新房只有这 1 个邻居，本身即新死胡同，且不吞掉已有死胡同）
    let guard = 0;
    while (deadEnds().length < 4 && guard < 60) {
      guard += 1;
      const parents = this.rng.shuffle(list().filter((room) => neighborCount(room.x, room.y) >= 2));
      let grew = false;
      for (const parent of parents) {
        const free = dirs
          .map((d) => ({ x: parent.x + d.x, y: parent.y + d.y }))
          .filter((s) => inBounds(s.x, s.y) && !rooms.has(`${s.x},${s.y}`) && neighborCount(s.x, s.y) === 1);
        if (free.length) {
          const s = free[0];
          put(s.x, s.y);
          grew = true;
          break;
        }
      }
      if (!grew) break;
    }

    return { rooms, path, ends: deadEnds().length };
  }

  // 隐藏房槽位扫描：返回地图空格（界内、至少 1 个邻居）及其邻居统计；
  // 邻居按房对象去重（合并后的大房占多格也只算 1 个邻居）；
  // 与普通房/Boss/隐藏房/超级隐藏房相邻信息一并给出（两种隐藏房都不得与 Boss/其他隐藏房相邻）
  hiddenSpots(rooms) {
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    const spots = new Map();
    // 按格子键迭代（大房每个占格都可能邻居着潜在槽位，非锚点格同样要扫）
    rooms.forEach((room, cellKey) => {
      const [cx, cy] = cellKey.split(",").map(Number);
      dirs.forEach((d) => {
        const x = cx + d.x;
        const y = cy + d.y;
        const key = `${x},${y}`;
        if (rooms.has(key) || Math.abs(x) > 3 || Math.abs(y) > 3) return;
        const around = [...new Set(
          dirs
            .map((dd) => rooms.get(`${x + dd.x},${y + dd.y}`))
            .filter(Boolean),
        )];
        const special = around.filter((neighbor) =>
          neighbor.type === "boss" || neighbor.type === "hidden" || neighbor.type === "superSecret").length;
        if (!around.length || special > 0) return;
        if (!spots.has(key)) spots.set(key, { x, y, neighbors: around.length, dist: Math.abs(x) + Math.abs(y) });
      });
    });
    return [...spots.values()];
  }

  // 原版隐藏房规则：普通隐藏房恰好 1 个，硬约束邻居 ≥3（放宽兜底 2，记 fallbackHidden 供冒烟断言）；
  // 超级隐藏房恰如可 1 个，硬约束邻居 ==1（死胡同隔壁），优选离起点远，找不到合法位则放弃
  addHiddenRoom(rooms) {
    const putSpecial = (spot, type) =>
      rooms.set(`${spot.x},${spot.y}`, {
        x: spot.x,
        y: spot.y,
        type,
        cleared: true,
        visited: false,
        itemTaken: false,
        unlocked: true,
        revealed: false,
        looted: false,
      });

    let spots = this.hiddenSpots(rooms);
    let secret = spots.filter((spot) => spot.neighbors >= 3).sort((a, b) => b.neighbors - a.neighbors || a.dist - b.dist)[0];
    if (!secret) secret = spots.filter((spot) => spot.neighbors === 2).sort((a, b) => a.dist - b.dist)[0];
    if (secret) putSpecial(secret, "hidden");

    spots = this.hiddenSpots(rooms);
    const superSpot = spots.filter((spot) => spot.neighbors === 1).sort((a, b) => b.dist - a.dist)[0];
    if (superSpot) putSpecial(superSpot, "superSecret");
  }

  // 调试 URL 参数落位（?room=类型或x,y / ?adj=类型 / ?reveal=1 / ?bigmap=1），仅供冒烟截图用
  applyDebugParams() {
    const params = new URLSearchParams(location.search);
    // ?room=类型|x,y|big|1x2|2x1|2x2：big/形状关键词跳多尺寸大房（截图/冒烟导航用；
    // 形状记法与规格一致：1x2=横向长房（w2 h1）、2x1=竖房（w1 h2）、2x2=四格大房）
    const findRoom = (type) => {
      const uniq = [...new Set(this.rooms.values())];
      if (type === "big") return uniq.find((room) => ((room.w || 1) * (room.h || 1)) > 1);
      const shape = type.match(/^([12])x([12])$/);
      if (shape) return uniq.find((room) => (room.w || 1) === Number(shape[2]) && (room.h || 1) === Number(shape[1]));
      return uniq.find((room) => room.type === type);
    };
    let dest = null;
    const roomParam = params.get("room");
    if (roomParam) {
      const coord = roomParam.match(/^(-?\d+),(-?\d+)$/);
      dest = (coord ? this.rooms.get(`${coord[1]},${coord[2]}`) : findRoom(roomParam)) || null;
    }
    const adjParam = params.get("adj");
    if (adjParam) {
      const target = findRoom(adjParam);
      if (target) {
        dest = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => this.rooms.get(`${target.x + dx},${target.y + dy}`))
          .find((near) => near && !SECRET_TYPES.has(near.type)) || dest;
      }
    }
    if (params.get("reveal")) {
      this.rooms.forEach((room) => {
        if (SECRET_TYPES.has(room.type)) room.revealed = true;
      });
    }
    if (params.get("allseen")) {
      this.rooms.forEach((room) => this.enteredRooms.add(`${room.x},${room.y}`));
    }
    if (dest) {
      this.current = { x: dest.x, y: dest.y };
      const dr = this.roomRect(dest);
      this.player.setPosition(dr.cx, dr.cy);
    }
    if (dest || params.get("reveal")) this.drawRoom();
    if (params.get("bigmap")) this.toggleBigmap();

    // ── 以下为纯调试参数（截图/冒烟用，正常游玩不触发）──
    // ?god=1：玩家不受伤害（截 Boss 战姿态不怕被碰死）
    if (params.get("god")) this.invulnerableUntil = Number.MAX_SAFE_INTEGER;
    // ?cue=jump|cough|charge|open：强制 Boss/小怪立刻出指定招式（Monstro 跳砸/咳弹簇、双子冲锋、Host 开壳散射）
    this.debugCue = params.get("cue") || null;
    // ?spawn=horf,host,red:crawler…：房间直接生成指定怪（逗号分隔；冒号前缀强制精英色）
    const spawnParam = params.get("spawn");
    if (spawnParam) {
      const dbgRect = this.curRoomRect();
      const entries = spawnParam.split(",").map((s) => s.trim()).filter(Boolean);
      entries.forEach((entry, i) => {
        const parts = entry.split(":");
        const champ = parts.length > 1 ? parts[0] : null;
        const kind = parts[parts.length - 1];
        const x = Phaser.Math.Clamp(dbgRect.cx + (i - (entries.length - 1) / 2) * 86, dbgRect.left + 50, dbgRect.right - 50);
        const y = dbgRect.cy + (i % 2 === 0 ? -64 : 48);
        const enemy = this.spawnEnemy(kind, x, y, { noChampion: true });
        if (enemy && champ && CHAMPION_TYPES[champ]) this.applyChampion(enemy, champ);
      });
    }
    // ?killat=毫秒[,毫秒…]：到点秒杀场上所有敌（配 ?spawn 截死亡联动序列，如大蜘蛛裂蛛/爆蝇引线；
    // 多时点配 ?walk 序列做"清房→换房"连锁压力脚本）；
    // 可选 &killmove=1：秒杀前把玩家传送到左下角，让死亡序列不跟玩家叠着，截图更可读
    const killAtParam = params.get("killat");
    if (killAtParam) {
      killAtParam.split(",").forEach((piece) => {
        const at = Number(piece.trim());
        if (!Number.isFinite(at) || at <= 100) return;
        this.time.delayedCall(at, () => {
          if (params.get("killmove")) {
            const kmRect = this.curRoomRect();
            this.player.setPosition(kmRect.left + 80, kmRect.bottom - 66);
          }
          this.enemies.getChildren().slice().forEach((enemy) => {
            if (enemy.active) this.damageEnemy(enemy, 9999);
          });
        });
      });
    }
    // ?freezeat=毫秒：到点冻结整局（gameEnded 置位 + 暂停全部 tween，画面定格当时的实体/弹体/特效），
    // 截图参数不再受启动耗时漂移影响（无结算浮层，纯画面定格）
    const freezeAt = Number(params.get("freezeat"));
    if (Number.isFinite(freezeAt) && freezeAt > 100) {
      this.time.delayedCall(freezeAt, () => {
        this.gameEnded = true;
        this.tweens.pauseAll(); // 连 tween 也冻住：引信红圈/爆炸闪光停在半途，截得正好
      });
    }
    // ?ff=毫秒：仅调试用——create 完成后把整局同步快进 ff 毫秒（逐 tick 模拟，定时器/
    // tween/物理一并走），供无头截图摆脱帧率影响；配合 ?killat/?spawn 定格任意时刻
    // ?walk=n|s|e|w|devil：ff 快进期间按住该方向走（devil=朝当前房恶魔门方向，兜底北），模拟按键走位；
    // 支持逗号序列（如 walk=n,e,s,w）：每 1200ms 切下一方向循环，供可玩性压力脚本
    const ffMs = Number(params.get("ff"));
    if (Number.isFinite(ffMs) && ffMs > 0) {
      const walkParam = params.get("walk");
      const walkSeq = (walkParam || "").split(",").map((s) => s.trim()).filter(Boolean);
      setTimeout(() => {
        const stepMs = 1000 / 60;
        const steps = Math.min(3600, Math.ceil(ffMs / stepMs)); // 上限 60s 模拟时长（压力脚本用）
        let t = this.time.now;
        for (let i = 0; i < steps; i += 1) {
          if (walkSeq.length) {
            const room = this.getRoom();
            const seg = walkSeq[Math.floor((i * stepMs) / 1200) % walkSeq.length];
            const dir = seg === "devil" ? (room && room.devilDoor) || "north" : seg;
            this.keys.up.isDown = dir === "north" || dir === "n";
            this.keys.down.isDown = dir === "south" || dir === "s";
            this.keys.left.isDown = dir === "west" || dir === "w";
            this.keys.right.isDown = dir === "east" || dir === "e";
          }
          t += stepMs;
          this.sys.step(t, stepMs);
        }
        if (walkSeq.length) {
          ["up", "down", "left", "right"].forEach((key) => {
            this.keys[key].isDown = false;
          });
        }
      }, 0);
    }
    // ?bombat=毫秒[,毫秒…]：到点在玩家脚下放炸弹（扣弹药约束豁免，截图/压力脚本用；
    // 与 E 键同走 placeBomb→引信→explodeAt 真实链路，可炸开相邻隐藏房墙）
    const bombAtParam = params.get("bombat");
    if (bombAtParam) {
      bombAtParam.split(",").forEach((piece) => {
        const at = Number(piece.trim());
        if (Number.isFinite(at) && at > 100) this.time.delayedCall(at, () => this.debugPlaceBomb());
      });
    }
    // ?devil=1：Boss 清理后必出恶魔门（截图/冒烟用）；?sale=1：商店 0 号商品强制红字半价签
    // ?active=1：直接发一件随机主动道具（截图/冒烟验证 HUD 主动方格、道具拾取路径，不进正常游玩）
    if (params.get("active")) {
      const actives = ITEM_POOL.filter((item) => item.type === "active");
      if (actives.length) this.applyItem(this.rng.pick(actives));
      this.updateHud(); // applyDebugParams 在 create 的 updateHud 之后跑，补一次刷新
    }
    // ?pause=1：加载完直接切暂停页（截图验证暂停页布局：种子号+属性面板）
    if (params.get("pause")) this.togglePause();
    // ?devilroom=1：直接进恶魔房（截图验证恶魔房内装，不走 Boss 门链路）
    if (params.get("devilroom")) this.enterDevilRoom();
  }

  // 冒烟断言（?smoke=1 触发）：20 个种子 × 3 层地图 + 全部模板自检，
  // 结果写 console 和 <pre id="smoke-report">（无头截图可读取），document.title 置 PASS/FAIL
  runMapSmoke() {
    const failures = [];
    const check = (ok, msg) => {
      if (!ok) failures.push(msg);
    };
    this.smokeTemplates(check);

    const savedRng = this.rng;
    const savedFloor = this.floor;
    const savedBoss = this.usedBossKinds;
    let superSecretCount = 0; // 超隐允许找不到合法位放弃，但应高频出现
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    for (let s = 0; s < 20; s += 1) {
      const seed = 10000 + s * 7919;
      this.usedBossKinds = new Set(); // 每个种子模拟一局（三层共享 Boss 不重复约束）
      for (let f = 1; f <= MAX_FLOOR; f += 1) {
        const tag = `seed=${seed} F${f}`;
        this.rng = new Phaser.Math.RandomDataGenerator([`${seed}:${f}`]);
        this.floor = f;
        const rooms = this.buildMap();
        // 大房合并后多个格子键映射同一房对象：房间级统计一律先去重
        const arr = [...new Set(rooms.values())];
        const normal = arr.filter((room) => !SECRET_TYPES.has(room.type));
        // 房数公式按占格数（合并不改变占地格数）：键即格子
        const cellKeys = new Set();
        rooms.forEach((room, cellKey) => {
          if (!SECRET_TYPES.has(room.type)) cellKeys.add(cellKey);
        });
        // 死胡同/邻居统计按房对象去重（大房多格只算 1 个邻居；隐藏类外挂房不改变"尽头房"性质）
        const neighborsOf = (room) => {
          const set = new Set();
          this.roomCells(room).forEach((cell) =>
            dirs.forEach((d) => {
              const near = rooms.get(`${cell.x + d.x},${cell.y + d.y}`);
              if (near && near !== room && !SECRET_TYPES.has(near.type)) set.add(near);
            }),
          );
          return set;
        };
        const neighborCount = (room) => neighborsOf(room).size;
        const adjacentTo = (room, types) => [...neighborsOf(room)].some((near) => types.includes(near.type));
        const dist = (room) => Math.abs(room.x) + Math.abs(room.y);
        // 死胡同统计含起点房（口径与 growFloorRooms/buildMap 的形状重摇规则一致）
        const ends = normal.filter((room) => neighborCount(room) === 1);
        const boss = normal.find((room) => room.type === "boss");
        const treasure = normal.find((room) => room.type === "treasure");
        const shop = normal.find((room) => room.type === "shop");
        const secret = arr.find((room) => room.type === "hidden");
        const superSecret = arr.find((room) => room.type === "superSecret");
        if (superSecret) superSecretCount += 1;

        // 房间数公式：6 + (0 或 1) + 层数×3（封顶 18），补死胡同最多再 +4
        const minN = Math.min(18, 6 + f * 3);
        check(cellKeys.size >= minN && cellKeys.size <= 22, `${tag} 房间格数 ${cellKeys.size} 不在 [${minN},22]`);
        check(ends.length >= 4, `${tag} 死胡同 ${ends.length} < 4`);
        check(Boolean(boss) && neighborCount(boss) === 1, `${tag} Boss 房不是死胡同`);
        if (boss) {
          const maxDist = Math.max(...ends.map(dist));
          check(dist(boss) === maxDist, `${tag} Boss 房距离 ${dist(boss)} ≠ 最远死胡同 ${maxDist}`);
        }
        check(Boolean(treasure) && dist(treasure) >= 2, `${tag} 宝箱房缺失或距离 <2`);
        check(Boolean(shop), `${tag} 商店缺失`);
        check(Boolean(secret), `${tag} 普通隐藏房缺失`);
        if (secret) {
          const n = neighborCount(secret);
          check(n >= 2 && n <= 4, `${tag} 隐藏房邻居数 ${n} 非法（大房去重口径）`);
          check(!adjacentTo(secret, ["boss"]), `${tag} 隐藏房与 Boss 相邻`);
          check(!adjacentTo(secret, ["superSecret"]), `${tag} 隐藏房与超级隐藏房相邻`);
        }
        if (superSecret) {
          check(neighborCount(superSecret) === 1, `${tag} 超级隐藏房邻居数 ${neighborCount(superSecret)} ≠ 1`);
          check(!adjacentTo(superSecret, ["boss"]), `${tag} 超级隐藏房与 Boss 相邻`);
          check(!adjacentTo(superSecret, ["hidden"]), `${tag} 超级隐藏房与隐藏房相邻`);
        }

        // ── Phase 6 多尺寸房断言 ──
        // 1) 大房数量 0-5（2-4 个双格目标 + ≤1 个 2×2 弹性），形状只许 1×2/2×1/2×2，
        //    cells 恰好铺满 w×h 矩形，每格键映射回本对象（互不重叠），且只有 combat 房可合并
        const big = normal.filter((room) => ((room.w || 1) * (room.h || 1)) > 1);
        check(big.length >= 0 && big.length <= 5, `${tag} 大房数量 ${big.length} 不在 [0,5]`);
        big.forEach((room) => {
          const w = room.w || 1;
          const h = room.h || 1;
          const cells = this.roomCells(room);
          check(
            w >= 1 && w <= 2 && h >= 1 && h <= 2 && w * h > 1 && cells.length === w * h,
            `${tag} 大房形状非法 ${w}x${h}（${cells.length} 格）`,
          );
          cells.forEach((cell) => {
            const inRect = cell.x >= room.x && cell.x < room.x + w && cell.y >= room.y && cell.y < room.y + h;
            check(inRect && rooms.get(`${cell.x},${cell.y}`) === room, `${tag} 大房 (${room.x},${room.y}) 格子越界/索引不一致`);
          });
          check(room.type === "combat", `${tag} 非 combat 房被合并（${room.type}）`);
          // 2) 门槽数 == 独立重算的外缘边数（内部格间界不开槽），槽位无重复
          const own = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
          let boundary = 0;
          cells.forEach((cell) =>
            dirs.forEach((d) => {
              if (!own.has(`${cell.x + d.x},${cell.y + d.y}`)) boundary += 1;
            }),
          );
          const slots = this.doorSlots(room);
          check(slots.length === boundary, `${tag} 大房门槽数 ${slots.length} ≠ 外缘边数 ${boundary}`);
          const slotKeys = new Set(slots.map((slot) => `${slot.cellX},${slot.cellY}:${slot.label}`));
          check(slotKeys.size === slots.length, `${tag} 大房门槽重复`);
        });
        // 3) 全部普通房格子 4-连通（换房走门可达）
        if (cellKeys.size) {
          const first = [...cellKeys][0];
          const seen = new Set([first]);
          const queue = [first];
          while (queue.length) {
            const [qx, qy] = queue.pop().split(",").map(Number);
            dirs.forEach((d) => {
              const k = `${qx + d.x},${qy + d.y}`;
              if (cellKeys.has(k) && !seen.has(k)) {
                seen.add(k);
                queue.push(k);
              }
            });
          }
          check(seen.size === cellKeys.size, `${tag} 普通房格子不连通（${seen.size}/${cellKeys.size}）`);
        }
      }
    }
    this.rng = savedRng instanceof Phaser.Math.RandomDataGenerator
      ? new Phaser.Math.RandomDataGenerator([`${this.runSeed}`])
      : savedRng;
    this.floor = savedFloor;
    this.usedBossKinds = savedBoss;
    check(superSecretCount >= 54, `超级隐藏房生成率过低：${superSecretCount}/60（应 ≥54）`);

    // ── Phase 6 几何单测 ──
    // curRoomRect 四例：1×1 与原 ROOM 完全一致（回归基准）；2×1/1×2/2×2 按单元外扩
    const expectRect = (room, want, tagR) => {
      const r = this.roomRect(room);
      check(
        r.left === want[0] && r.top === want[1] && r.right === want[2] && r.bottom === want[3],
        `${tagR} 矩形 ${r.left},${r.top},${r.right},${r.bottom} ≠ 期望 ${want.join(",")}`,
      );
    };
    expectRect({ x: 0, y: 0 }, [142, 88, 818, 452], "curRoomRect 1×1");
    expectRect({ x: 0, y: 0, w: 2, h: 1 }, [142, 88, 1494, 452], "curRoomRect 1×2");
    expectRect({ x: 0, y: 0, w: 1, h: 2 }, [142, 88, 818, 816], "curRoomRect 2×1");
    expectRect({ x: 0, y: 0, w: 2, h: 2 }, [142, 88, 1494, 816], "curRoomRect 2×2");
    // 1×1 渲染回归：底图 key 直回本层 sealed（不拼新图）、门槽恰为原四槽位
    check(this.bigRoomBackdropKey({}) === this.roomBackdropKey(), "1×1 底图未走原 sealed 路径（回归破坏）");
    const slots11 = this.doorSlots({ x: 0, y: 0 });
    const slotSig = slots11.map((s) => `${s.label}:${s.cx},${s.cy}`).sort().join("|");
    check(
      slotSig === "east:818,270|north:480,88|south:480,452|west:142,270",
      `1×1 门槽签名漂移：${slotSig}`,
    );
    const doorRects11 = slots11.map((s) => this.slotDoorRect(s, this.roomRect({ x: 0, y: 0 })));
    const n = doorRects11.find((d) => d.label === "north");
    const e = doorRects11.find((d) => d.label === "east");
    check(n && n.x === 434 && n.y === 14 && e && e.x === 851 && e.y === 224, "1×1 门绘制矩形与原几何不一致");
    // 模板 stamp 格基 offset：抽查格心 = 锚点 + 52 对齐（1×2 右格左上角 (0,0) 格心）
    const s0 = this.stampCellCenter(0, 0, 0, 0);
    const s1 = this.stampCellCenter(CELL_W, 0, 0, 0);
    const s2 = this.stampCellCenter(0, CELL_H, 6, 12);
    check(s0.x === ROOM.left + 26 && s0.y === ROOM.top + 26, `stamp 基准格心错位 ${s0.x},${s0.y}`);
    check(s1.x === ROOM.left + CELL_W + 26 && s1.x - s0.x === CELL_W, `stamp 横向 offset 错位 ${s1.x - s0.x}`);
    check(
      s2.x === ROOM.left + 12.5 * (CELL_W / TEMPLATE_COLS) && s2.y === ROOM.top + CELL_H + 6.5 * (CELL_H / TEMPLATE_ROWS),
      `stamp 纵向 offset 错位 ${s2.x},${s2.y}`,
    );
    // 小怪普通弹纹理改为血红（原版 f_0106）：贴图存在且采样点为红色系
    check(this.textures.exists("enemyShotSmall"), "缺贴图 enemyShotSmall（小怪红弹）");
    check(!this.textures.exists("enemyShot"), "旧蓝弹贴图 enemyShot 未移除");
    if (this.textures.exists("enemyShotSmall")) {
      const src = this.textures.get("enemyShotSmall").getSourceImage();
      const px = src.getContext("2d").getImageData(8, 8, 1, 1).data;
      check(px[0] > 120 && px[0] > px[1] * 1.5 && px[0] > px[2] * 1.5, `小怪弹非红色系 rgb(${px[0]},${px[1]},${px[2]})`);
    }

    // ── Phase 3 怪物阵容断言 ──
    // 敌池 kind：有专属处理器或 chase 兜底，且贴图已注册（SPRITES 映射或同名 key）
    Object.entries(FLOOR_THEMES).forEach(([f, theme]) => {
      theme.pool.forEach((kind) => {
        check(Boolean(ENEMY_HANDLERS[kind] || ENEMY_HANDLERS.chase), `F${f} 池怪 ${kind} 无处理器`);
        check(this.textures.exists(SPRITES[kind] || kind), `F${f} 池怪 ${kind} 缺贴图 ${SPRITES[kind] || kind}`);
      });
    });
    // 新怪每种至少进一个地层池（horf/host/pooter/hopper/spider/bigSpider/boomFly/sucker/mulligan）
    ["horf", "host", "pooter", "hopper", "spider", "bigSpider", "boomFly", "sucker", "mulligan"].forEach((kind) => {
      check(Object.values(FLOOR_THEMES).some((theme) => theme.pool.includes(kind)), `新怪 ${kind} 不在任何地层池`);
    });
    // Boss 全家贴图（双子走运行时裁半）与精英色系表
    Object.entries(BOSS_TEXTURES).forEach(([kind, tex]) => check(this.textures.exists(tex), `Boss ${kind} 缺贴图 ${tex}`));
    check(this.textures.exists("geminiBig") && this.textures.exists("geminiSmall"), "双子分体贴图 geminiBig/geminiSmall 缺失");
    this.textures.exists("monstroJump") && this.textures.exists("monstroMad") || check(false, "萌死戳跳跃/狂暴帧缺失");
    ["red", "blue", "black", "gold"].forEach((c) => check(Boolean(CHAMPION_TYPES[c]), `精英色 ${c} 未定义`));
    // 站位标记指向的怪种贴图必须存在（seedEnemies 对楼层池有回退，此处只验贴图）
    TEMPLATE_ENEMY_MARKS.forEach((ch) => {
      const kind = TEMPLATE_KINDS[ch];
      check(Boolean(kind) && this.textures.exists(SPRITES[kind] || kind), `站位标记 ${ch}→${kind} 缺贴图`);
    });

    const summary = failures.length
      ? `SMOKE FAIL：${failures.length} 条断言失败`
      : "SMOKE PASS：模板自检 + 20 种子 × 3 层地图断言 + 多尺寸房/门槽/几何单测全部通过";
    console.log(summary);
    failures.forEach((line) => console.warn(line));
    const pre = document.createElement("pre");
    pre.id = "smoke-report";
    pre.style.cssText =
      "position:absolute;left:12px;top:12px;z-index:99;margin:0;padding:10px 14px;" +
      "background:rgba(8,6,5,0.9);color:#9fe08a;font:14px/1.5 monospace;white-space:pre-wrap;";
    pre.textContent = [summary, ...failures].join("\n");
    document.body.appendChild(pre);
    document.title = failures.length ? "SMOKE FAIL" : "SMOKE PASS";
    // 怪物行为模拟（smokeEnemySim）结束后会回填这份报告
    this.smokeReport = { failures, pre };
  }

  // 冒烟·Phase 4 断言（?smoke=1，由 smokeEnemySim 调用）：商店定价表/等级件数、
  // 隐藏房内装权重、恶魔门标记与贴图路径、恶魔交易双支付分支；
  // 构造的假 Boss 房在断言后即时拆除并恢复现场，不污染起始房
  smokePhase4(check) {
    const savedRng = this.rng;
    this.rng = new Phaser.Math.RandomDataGenerator(["smoke-phase4"]);
    const savedCurrent = { x: this.current.x, y: this.current.y };
    const savedDonated = this.shopDonated;
    try {
      // 1) SHOP_OFFERS 每项价格 ∈ 原版表（红心 3¢，其余拾取物一律 5¢）
      const priceTable = { heart: 3, key: 5, bomb: 5, battery: 5, pill: 5, card: 5, soulHeart: 5 };
      SHOP_OFFERS.forEach((offer) => {
        check(offer.price === priceTable[offer.kind], `商店商品 ${offer.kind} 价格 ${offer.price} ≠ 原版 ${priceTable[offer.kind]}`);
      });

      // 2) 商店等级 → 商品件数：0 级 2 件 / 1 级 3 件 / 2 级 4 件
      const counts = [0, 5, 10].map((donated) => {
        this.shopDonated = donated;
        return this.buildShopStock({ shopStock: null }).length;
      });
      check(counts.join(",") === "2,3,4", `商店 0/1/2 级商品数 ${counts.join(",")} ≠ 2,3,4`);
      // 红字半价签：价格 = 原价减半向上取整（道具按 15/10¢ 两档基准）
      let saleSlot = null;
      for (let i = 0; i < 60 && !saleSlot; i += 1) {
        this.shopDonated = 0;
        saleSlot = this.buildShopStock({ shopStock: null }).find((slot) => slot.sale) || null;
      }
      check(Boolean(saleSlot), "60 次商店抽签未出现任何 SALE 红签（15% 概率异常）");
      if (saleSlot) {
        const expected = saleSlot.kind === "item" ? [8, 5] : [Math.ceil(priceTable[saleSlot.kind] / 2)];
        check(expected.includes(saleSlot.price), `SALE 商品 ${saleSlot.kind} 价格 ${saleSlot.price} 不在 ${expected.join("/")}`);
      }

      // 3) 本阶段新增贴图全部注册（官方店主/特殊店主/红箱/程序捐款机/官方恶魔门）
      ["shopkeeper", "shopkeeperSpecial", "redChest", "donation", "devilDoor"].forEach((key) => {
        check(this.textures.exists(key), `缺贴图 ${key}`);
      });

      // 4) 普通隐藏房内装：40 连抽——组数 2-3、种类 ∈ 权重表且不重复
      const hiddenKinds = HIDDEN_LOOT_TABLE.map((entry) => entry[0]);
      for (let i = 0; i < 40; i += 1) {
        const groups = this.rollLootTable(HIDDEN_LOOT_TABLE, this.rng.between(2, 3));
        check(groups.length >= 2 && groups.length <= 3, `隐藏房内容组数 ${groups.length} 非法`);
        check(new Set(groups).size === groups.length, `隐藏房内容重复 ${groups.join("+")}`);
        groups.forEach((kind) => check(hiddenKinds.includes(kind), `隐藏房内容 ${kind} 不在权重表`));
      }

      // 5) 超隐内装：40 连抽——1-2 组、⊆ 超隐权重表、永不出 ITEM_POOL 道具组
      const superKinds = SUPER_SECRET_LOOT_TABLE.map((entry) => entry[0]);
      for (let i = 0; i < 40; i += 1) {
        const groups = this.rollLootTable(SUPER_SECRET_LOOT_TABLE, this.rng.between(1, 2));
        check(groups.every((kind) => superKinds.includes(kind) && kind !== "item"), `超隐内装超范围 ${groups.join("+")}`);
      }

      // 6) 恶魔门：构造已清理 Boss 房并强制触发——标记落位（无邻居 → 北墙幽灵门），drawDoors 走 devilDoor 贴图
      const bossRoom = {
        x: 6, y: 6, type: "boss", cleared: true, visited: true, itemTaken: false,
        unlocked: true, revealed: true, looted: false,
      };
      this.rooms.set("6,6", bossRoom);
      this.spawnBossReward(bossRoom, true);
      check(bossRoom.devilDoor === "north", `无邻居 Boss 房恶魔门应为北墙幽灵门，实际 ${bossRoom.devilDoor}`);
      // 直调 spawnBossReward 落出的奖励拾取物是副作用，切房前清掉（不留在起始房 groundDrops）
      this.pickups.clear(true, true);
      this.floorExits.clear(true, true);
      this.current = { x: 6, y: 6 };
      this.drawRoom();
      const devilDoorG = this.doorGraphics.find((g) => g.doorKind === "devil");
      check(Boolean(devilDoorG), "drawDoors 未渲染恶魔门");
      check(devilDoorG && devilDoorG.doorTexture === "devilDoor", "恶魔门未走 devilDoor 官方贴图路径");
      // 拆除假房：清掉它带出的商品/出口拾取物，回起始房重绘
      this.pickups.clear(true, true);
      this.floorExits.clear(true, true);
      this.rooms.delete("6,6");
      this.current = savedCurrent;
      this.drawRoom();

      // 7) 恶魔交易双支付分支三构造：红容器够 / 纯魂心 6 / 都不够拒付
      const pact = DEVIL_POOL.find((deal) => deal.name === "契约");
      const mark = DEVIL_POOL.find((deal) => deal.name === "标记");
      let stats = { hp: 6, maxHp: 6, soulHp: 0, damage: 1, speed: 190 };
      check(this.devilDealMode(stats, 2) === "container", "心容器足够时应走容器支付");
      const dealA = { ...pact, taken: false };
      this.payDevilDeal(stats, dealA, "container");
      check(stats.maxHp === 2 && stats.soulHp === 2 && Math.abs(stats.damage - 1.8) < 1e-6 && dealA.taken, "容器支付结算异常");
      stats = { hp: 2, maxHp: 2, soulHp: 6, damage: 1, speed: 190 };
      check(this.devilDealMode(stats, 1) === "soul", "容器不够且魂心 6 应走纯魂心支付");
      const dealB = { ...mark, taken: false };
      this.payDevilDeal(stats, dealB, "soul");
      check(stats.soulHp === 0 && stats.maxHp === 2 && Math.abs(stats.damage - 1.4) < 1e-6 && dealB.taken, "魂心支付结算异常");
      stats = { hp: 2, maxHp: 2, soulHp: 4, damage: 1, speed: 190 };
      check(this.devilDealMode(stats, 1) === null, "容器和魂心都不够应拒付");

      check(DEVIL_POOL.length === 8, `恶魔房交易池应为 8 件，实际 ${DEVIL_POOL.length}`);

      // 8) 官方门洞贴图（extract-doors.py 从三层渲染抠取）：三层 key 注册齐全；
      // 起始房已走 drawRoom——每个普通门（非破洞）都垫了门洞贴图，且北向原图按槽位
      // flipY/±90° 变换（doorHolePose 插桩：宽口必须朝房外）
      ["doorHoleBasement", "doorHoleCaves", "doorHoleDepths"].forEach((key) => {
        check(this.textures.exists(key), `缺门洞贴图 ${key}`);
      });
      const holeDoors = this.doorGraphics.filter((g) => g.doorKind !== "hole");
      check(holeDoors.length > 0, "起始房没有任何实体门槽（门洞贴图无从断言）");
      const expectPose = {
        north: "north:rot0.000,flipY=false",
        south: "south:rot0.000,flipY=true",
        east: "east:rot1.571,flipY=false",
        west: "west:rot-1.571,flipY=false",
      };
      holeDoors.forEach((g) => {
        check(
          g.doorHolePose === expectPose[g.doorLabel],
          `${g.doorLabel} 门洞变换去向异常：${g.doorHolePose}（贴图 ${g.doorTexture}）`,
        );
        check(String(g.doorTexture).length > 0, `${g.doorLabel} 门未记录主贴图`);
      });
      // 普通未清门（closed）/清房门（open）主贴图必须是本层门洞；按层选 key
      check(this.doorHoleKey() === "doorHoleBasement", `1 层门洞 key 异常 ${this.doorHoleKey()}`);
    } finally {
      this.shopDonated = savedDonated;
      this.rng = savedRng;
    }
  }

  // 冒烟·Phase 7 断言（?smoke=1，由 smokeEnemySim 调用，玩家/障碍组已就位）：
  // 沟壑模板按 13×7 全落地（曾捕获：RandomDataGenerator 无 .bool() 异常致放置到第二格中断），
  // 贴图按楼层分 pitBasement/pitCaves/pitDepths、判定圈 = 显示宽 0.40；断言后现场自恢复
  smokePhase7(check) {
    const tpl = ROOM_TEMPLATES.find((t) => t.name === "中央十字沟壑");
    const savedPitFloor = this.floor;
    [1, 2, 3].forEach((f) => {
      this.floor = f;
      const created = [];
      const origCreate = this.obstacles.create.bind(this.obstacles);
      this.obstacles.create = (...args) => {
        const o = origCreate(...args);
        created.push(o);
        return o;
      };
      this.placeLayoutTemplate(tpl, new Phaser.Math.RandomDataGenerator([`smoke-pit-${f}`]), 0, 0);
      this.obstacles.create = origCreate;
      const pits = created.filter((o) => o.kind === "pit");
      check(pits.length === 14, `F${f} 沟壑模板落地 ${pits.length}/14（模板放置被中断）`);
      if (pits.length) {
        check(
          pits[0].texture.key === ["pitBasement", "pitCaves", "pitDepths"][f - 1],
          `F${f} 沟壑贴图 ${pits[0].texture.key} 分层错误`,
        );
        check(
          Math.abs(pits[0].body.radius - Math.min(pits[0].displayWidth, pits[0].displayHeight) * 0.4) < 0.5,
          `F${f} 沟壑判定圈 ${pits[0].body.radius} ≠ 0.40 比例`,
        );
      }
      created.forEach((o) => o.destroy());
      this.roomObjects = this.roomObjects.filter((o) => !created.includes(o));
      this.obstacleZones = [];
    });
    this.floor = savedPitFloor;
  }

  // 冒烟·怪物行为模拟（?smoke=1 触发，runMapSmoke 之后由 create 延迟调用）：
  // 旧怪+每种新怪各构造 1 只，虚拟时间手动步进 3 秒 updateEnemies，再走死亡联动路径
  // （大蜘蛛裂蛛/爆蝇引线/吸盘十字弹/吸星自爆），断言全程不抛异常、坐标有限；
  // 结束后清场恢复（0,0 起始房本已清理，不会触发二次发奖）
  smokeEnemySim() {
    const report = this.smokeReport;
    if (!report) return;
    const { failures, pre } = report;
    const check = (ok, msg) => {
      if (!ok) failures.push(msg);
    };
    const baseFailureCount = failures.length;
    this.smokePhase4(check); // Phase 4：商店/隐藏房/恶魔门/恶魔交易断言（现场自恢复）
    this.smokePhase7(check); // Phase 7：沟壑模板放置/贴图分层/判定圈比例断言（现场自恢复）
    const kinds = ["crawler", "fly", "charger", "horf", "host", "pooter", "hopper", "spider", "bigSpider", "boomFly", "sucker", "mulligan"];
    const saveX = this.player.x;
    const saveY = this.player.y;
    const savedRng = this.rng;
    this.rng = new Phaser.Math.RandomDataGenerator(["smoke-enemy-sim"]);
    this.player.setPosition(ROOM.cx, ROOM.cy + 130);
    const spawned = [];
    let simError = null;
    try {
      kinds.forEach((kind, i) => {
        spawned.push(this.spawnEnemy(kind, ROOM.cx + (i - (kinds.length - 1) / 2) * 54, ROOM.cy - 110, { noChampion: true }));
      });
      const start = this.time.now + 100;
      for (let t = start; t < start + 3000; t += 50) this.updateEnemies(t, 50);
      // 精英四色构造 + 死亡联动（裂蛛/爆蝇/自爆/十字弹/精英掉落）也走一遍
      ["red", "blue", "black", "gold"].forEach((color, i) => {
        const enemy = this.spawnEnemy("crawler", ROOM.cx + (i - 1.5) * 60, ROOM.cy + 40, { noChampion: true });
        this.applyChampion(enemy, color);
        spawned.push(enemy);
      });
      // 自弃者自爆链路（引线 → selfBoom → explodeAt + 召苍蝇，苍蝇走真实 150ms 定时器）
      const mulligan = spawned[11];
      if (mulligan.active) {
        mulligan.state = "fuse";
        mulligan.stateUntil = start + 10;
      }
      for (let t = start + 3000; t < start + 3400; t += 50) this.updateEnemies(t, 50);
      [8, 9, 10, 12, 13, 14, 15].forEach((idx) => {
        const enemy = spawned[idx];
        if (enemy && enemy.active) this.damageEnemy(enemy, 9999);
      });
      for (let t = start + 3400; t < start + 3700; t += 50) this.updateEnemies(t, 50);
    } catch (err) {
      simError = err;
    }
    check(!simError, `怪物模拟抛异常：${simError && (simError.stack || simError.message || simError)}`);
    this.enemies.children.each((enemy) => {
      if (enemy.active) check(Number.isFinite(enemy.x) && Number.isFinite(enemy.y), `模拟后 ${enemy.kind} 坐标非法`);
    });
    // 清场恢复（吸星自爆召苍蝇走真实 150ms 定时器，可能随后落在起始房——冒烟截图里正好作为联动证据）
    spawned.forEach((enemy) => {
      if (enemy.active) enemy.destroy();
    });
    this.enemies.clear(true, true);
    this.enemyShots.clear(true, true);
    this.player.setPosition(saveX, saveY);
    this.rng = savedRng;
    const simNote = failures.length === baseFailureCount ? "怪物行为模拟通过（12 种怪 × 3 秒 + 精英四色 + 死亡联动）" : null;
    const summary = failures.length
      ? `SMOKE FAIL：${failures.length} 条断言失败`
      : `SMOKE PASS：模板自检 + 20 种子 × 3 层地图/多尺寸房/门槽断言 + 商店/隐藏房/恶魔门/交易断言 + 怪物贴图/行为模拟全部通过`;
    pre.textContent = [summary, simNote, ...failures].filter(Boolean).join("\n");
    document.title = failures.length ? "SMOKE FAIL" : "SMOKE PASS";
  }

  // 模板库自检：尺寸、进房格/中心格留空、可通行连通性（敌人标记格视为可走）；
  // 进房格外的门侧 1 格允许障碍（连通性保证可绕行），与既有模板库的一致口径
  smokeTemplates(check) {
    const entryCells = [[0, 6], [6, 6], [3, 0], [3, 12]];
    ROOM_TEMPLATES.forEach((tpl) => {
      check(tpl.rows.length === TEMPLATE_ROWS, `模板「${tpl.name}」行数 ${tpl.rows.length} ≠ ${TEMPLATE_ROWS}`);
      const walkable = (r, c) => {
        const ch = tpl.rows[r][c];
        return ch === "." || TEMPLATE_ENEMY_MARKS.has(ch);
      };
      tpl.rows.forEach((row, r) => {
        check(row.length === TEMPLATE_COLS, `模板「${tpl.name}」第 ${r} 行宽度 ${row.length} ≠ ${TEMPLATE_COLS}`);
        for (const ch of row) check(ch in TEMPLATE_KINDS || ch === ".", `模板「${tpl.name}」未知字符 ${ch}`);
      });
      entryCells.forEach(([r, c]) => {
        check(tpl.rows[r] && tpl.rows[r][c] === ".", `模板「${tpl.name}」进房格 (${r},${c}) 未留空`);
      });
      check(tpl.rows[3][6] === ".", `模板「${tpl.name}」中心格未留空`);
      // BFS 连通性：从第一个可走格出发必须覆盖全部可走格
      let start = null;
      let total = 0;
      tpl.rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c += 1) {
          if (walkable(r, c)) {
            total += 1;
            if (!start) start = [r, c];
          }
        }
      });
      const seen = new Set([`${start[0]},${start[1]}`]);
      const queue = [start];
      while (queue.length) {
        const [r, c] = queue.shift();
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
          const nr = r + dr;
          const nc = c + dc;
          const key = `${nr},${nc}`;
          if (nr < 0 || nr >= TEMPLATE_ROWS || nc < 0 || nc >= TEMPLATE_COLS) return;
          if (seen.has(key) || !walkable(nr, nc)) return;
          seen.add(key);
          queue.push([nr, nc]);
        });
      }
      check(seen.size === total, `模板「${tpl.name}」可走格不连通（${seen.size}/${total}）`);
    });
  }

  getRoom(x = this.current.x, y = this.current.y) {
    return this.rooms.get(`${x},${y}`);
  }

  // 房对象占格列表：合并房存 room.cells，未合并的房回退单格（锚点即房间坐标）
  roomCells(room) {
    return room.cells || [{ x: room.x, y: room.y }];
  }

  // 房对象的世界矩形（含 cx/cy 与格数 w/h）：left/top 永为 142/88（世界即屏外整体外扩），
  // 1×1 时与原 ROOM 完全一致；大房 right/bottom 按单元整块外扩
  roomRect(room) {
    const w = (room && room.w) || 1;
    const h = (room && room.h) || 1;
    const left = ROOM.left;
    const top = ROOM.top;
    const right = ROOM.left + CELL_W * w;
    const bottom = ROOM.top + CELL_H * h;
    return { left, top, right, bottom, cx: left + (right - left) / 2, cy: top + (bottom - top) / 2, w, h };
  }

  // 当前房世界矩形（drawRoom 时缓存 this.curRect，帧内热点直接读缓存）
  curRoomRect() {
    return this.roomRect(this.getRoom());
  }

  // 世界尺寸（含四面墙带）：镜头/物理世界边界用；1×1 恰为 WIDTH×HEIGHT
  worldSize(rect) {
    return { width: rect.right + WALL_X, height: rect.bottom + WALL_Y };
  }

  // 门槽位模型：房对象每个占格的外边界中点一个槽（大房内部格间界不开槽）。
  // 返回 [{label,dx,dy,cellX,cellY,nx,ny,cx,cy}]：cx/cy 为该槽中心的世界坐标。
  doorSlots(room) {
    const w = (room && room.w) || 1;
    const h = (room && room.h) || 1;
    const slots = [];
    this.roomCells(room).forEach((cell) => {
      const col = cell.x - room.x;
      const row = cell.y - room.y;
      const cx = ROOM.left + col * CELL_W + CELL_W / 2;
      const cy = ROOM.top + row * CELL_H + CELL_H / 2;
      if (row === 0) slots.push({ label: "north", dx: 0, dy: -1, cellX: cell.x, cellY: cell.y, nx: cell.x, ny: cell.y - 1, cx, cy: ROOM.top });
      if (row === h - 1) slots.push({ label: "south", dx: 0, dy: 1, cellX: cell.x, cellY: cell.y, nx: cell.x, ny: cell.y + 1, cx, cy: ROOM.top + h * CELL_H });
      if (col === 0) slots.push({ label: "west", dx: -1, dy: 0, cellX: cell.x, cellY: cell.y, nx: cell.x - 1, ny: cell.y, cx: ROOM.left, cy });
      if (col === w - 1) slots.push({ label: "east", dx: 1, dy: 0, cellX: cell.x, cellY: cell.y, nx: cell.x + 1, ny: cell.y, cx: ROOM.left + w * CELL_W, cy });
    });
    return slots;
  }

  // 槽位对应的门绘制矩形（与 1×1 原几何逐像素一致：N/S 门嵌上下墙带、E/W 门嵌侧墙带正中）
  slotDoorRect(slot, rect) {
    if (slot.label === "north") return { x: slot.cx - 46, y: ROOM.top - 74, w: 92, h: 72, label: "north" };
    if (slot.label === "south") return { x: slot.cx - 46, y: rect.bottom - 6, w: 92, h: 72, label: "south" };
    if (slot.label === "west") return { x: Math.round(ROOM.left / 2) - 38, y: slot.cy - 46, w: 76, h: 92, label: "west" };
    return { x: rect.right + Math.round(WALL_X / 2) - 38, y: slot.cy - 46, w: 76, h: 92, label: "east" };
  }

  // 换房落点：从 fromCell(fromCellX,fromCellY) 经 exitLabel 方向走进 target 房，
  // 落在 target 对应槽位内侧（各房几何屏本地化，与 1×1 原落点公式一致）
  slotLanding(target, fromCellX, fromCellY, exitLabel) {
    const rect = this.roomRect(target);
    const col = fromCellX - target.x;
    const row = fromCellY - target.y;
    const cx = ROOM.left + col * CELL_W + CELL_W / 2;
    const cy = ROOM.top + row * CELL_H + CELL_H / 2;
    if (exitLabel === "north") return { x: cx, y: rect.bottom - 34 };
    if (exitLabel === "south") return { x: cx, y: rect.top + 34 };
    if (exitLabel === "west") return { x: rect.right - 34, y: cy };
    return { x: rect.left + 34, y: cy };
  }

  // 模板格心：格基 offset（ox/oy 为大房内格偏移的世界像素）+ 13×7 格内行列
  stampCellCenter(ox, oy, r, c) {
    return {
      x: ROOM.left + ox + (c + 0.5) * (CELL_W / TEMPLATE_COLS),
      y: ROOM.top + oy + (r + 0.5) * (CELL_H / TEMPLATE_ROWS),
    };
  }

  // 玩家当前所在的门槽（在给定方向的任一槽巷内；巷宽沿用原 46px 容差）
  slotForPlayer(room, direction, slack = 46) {
    const slots = (this.curRoom === room && this.curSlots) ? this.curSlots : this.doorSlots(room);
    return slots.find((slot) => {
      if (slot.label !== direction) return false;
      return direction === "north" || direction === "south"
        ? Math.abs(this.player.x - slot.cx) <= slack
        : Math.abs(this.player.y - slot.cy) <= slack;
    }) || null;
  }

  fitDisplaySize(gameObject, target) {
    const frame = gameObject.frame;
    const w = (frame && frame.width) || gameObject.width || 1;
    const h = (frame && frame.height) || gameObject.height || 1;
    const scale = target / Math.max(w, h);
    gameObject.setDisplaySize(w * scale, h * scale);
    return gameObject;
  }

  addRoomObject(object, depth = DEPTH.room) {
    object.setDepth(depth);
    this.roomObjects.push(object);
    return object;
  }

  makeRoomRng(room) {
    return new Phaser.Math.RandomDataGenerator([`${this.runSeed}:${room.x}:${room.y}:${room.type}`]);
  }

  drawRoom() {
    // 先停掉房间对象上的 tween（如底座道具的浮动），再销毁，避免游离 tween 操作已销毁对象
    this.roomObjects.forEach((object) => {
      this.tweens.killTweensOf(object);
      object.destroy();
    });
    this.roomObjects = [];

    const leaving = this.rooms.get(this.activeRoomKey);
    if (leaving) {
      leaving.groundDrops = [];
      this.pickups.children.each((pickup) => {
        if (!pickup.active) return;
        if (["heart", "coin", "key", "bomb", "soulHeart", "pill", "card", "battery"].includes(pickup.kind)) {
          leaving.groundDrops.push({ kind: pickup.kind, x: pickup.x, y: pickup.y, pillId: pickup.pillId, cardId: pickup.cardId });
        } else if (pickup.kind === "droppedItem") {
          leaving.groundDrops.push({ kind: "droppedItem", item: pickup.item, x: pickup.x, y: pickup.y });
        }
      });
    }

    this.enemies.children.each((enemy) => {
      if (enemy.bar) {
        enemy.bar.destroy();
        enemy.bar = null;
      }
      if (enemy.barLabel) {
        enemy.barLabel.destroy();
        enemy.barLabel = null;
      }
      if (enemy.tether) {
        enemy.tether.destroy();
        enemy.tether = null;
      }
      this.tweens.killTweensOf(enemy); // 防游离 tween 操作已销毁敌人
    });
    this.enemies.clear(true, true);
    this.tears.clear(true, true);
    this.enemyShots.clear(true, true);
    this.pickups.clear(true, true);
    this.floorExits.clear(true, true);
    this.obstacles.clear(true, true);
    this.obstacleZones = [];
    this.placedBombs.forEach((bomb) => bomb.destroy());
    this.placedBombs = [];
    this.shopkeepers = [];
    this.doorGraphics = [];
    if (this.donationCollider) {
      // 捐款机碰撞器：挂在具体房间对象上，换房时解绑（机器本体随 roomObjects 销毁）
      this.physics.world.removeCollider(this.donationCollider);
      this.donationCollider = null;
    }

    const room = this.getRoom();
    room.visited = true;
    this.enteredRooms.add(`${room.x},${room.y}`);
    this.activeRoomKey = `${room.x},${room.y}`;

    const roomRng = this.makeRoomRng(room);

    // 当前房几何缓存（keepInRoom/tryDoorTransition 等帧内热点直接读，不重复算槽位）
    this.curRoom = room;
    this.curRect = this.roomRect(room);
    this.curSlots = this.doorSlots(room);
    const rect = this.curRect;

    // 镜头与物理世界：按当前房世界尺寸设边界（1×1 恰为一屏，跟随不产生偏移）；
    // 进房即 startFollow + centerOn（瞬移换房无滑动过渡，lerp 只负责房内跟随）
    const world = this.worldSize(rect);
    const cam = this.cameras.main;
    cam.setBounds(0, 0, world.width, world.height);
    this.physics.world.setBounds(0, 0, world.width, world.height);
    cam.startFollow(this.player, false, 0.1, 0.1);
    cam.centerOn(this.player.x, this.player.y);

    // 楼层皮肤底图按层选（sealRoomBackdrop 已给每层生成 sealed 版本）；底图自身即楼层主题，
    // 不再整图 tint，仅特殊房保留淡染色。大房底图运行时拼接缓存（bigRoomBackdropKey），
    // 尺寸即世界尺寸；1×1 走原 960×540 路径，逐像素不变
    const isBig = rect.w > 1 || rect.h > 1;
    const backdrop = isBig
      ? this.add.image(0, 0, this.bigRoomBackdropKey(room)).setOrigin(0, 0)
      : this.add.image(WIDTH / 2, HEIGHT / 2, this.roomBackdropKey());
    backdrop.setDisplaySize(world.width, world.height);
    const typeTints = { treasure: 0xd8fff4, hidden: 0xf0dcff, superSecret: 0x9a7cd0, boss: 0xffd7e3, devil: 0xffc2c2 };
    const backdropTint = typeTints[room.type] ? this.mixColors(0xffffff, typeTints[room.type], 0.6) : 0xffffff;
    if (backdropTint !== 0xffffff) backdrop.setTint(backdropTint);
    this.addRoomObject(backdrop, DEPTH.backdrop);

    // 血渍合并图层：敌人死亡时往里画暗红渍团，离开房间随 roomObjects 一起销毁
    this.bloodDecals = [];
    this.bloodFadeUntil = 0;
    this.bloodLayer = this.addRoomObject(this.add.graphics(), DEPTH.pickup - 5);

    this.spawnRoomObstacles(room, roomRng);
    this.scatterRubble(room, roomRng);

    // v10 起壁炉不再每房四角固定：只由战斗模板 F 格驱动（起始/商店/隐藏等无 F 不放；
    // 原 Stage_Basement 渲染墙角本无火堆；隐藏房尸体双火堆为官方固定布局保留，恶魔房装饰火同）

    this.drawDoors(room);

    // ?oblabel=1：调试参数——给每个障碍标 8px 小字（kind:贴图key），复核障碍贴图错误用
    if (new URLSearchParams(location.search).get("oblabel")) {
      this.obstacles.children.each((o) => {
        if (!o.active) return;
        const tag = this.add
          .text(o.x, o.y + o.displayHeight / 2 + 2, `${o.kind}:${o.texture && o.texture.key}`, {
            fontFamily: "monospace",
            fontSize: "8px",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 2,
          })
          .setOrigin(0.5, 0);
        this.addRoomObject(tag, DEPTH.ui - 1);
      });
    }

    if (room.groundDrops && room.groundDrops.length) {
      room.groundDrops.forEach((drop) => {
        if (drop.kind === "droppedItem") this.spawnDroppedItem(drop.item, drop.x, drop.y);
        else this.spawnPickup(drop.kind, drop.x, drop.y, drop);
      });
    }

    if (room.type === "boss" && room.cleared) {
      this.spawnBossReward(room);
    } else if (room.type === "treasure") {
      this.spawnItemPedestal(room);
      // 宝箱房小概率额外刷一只箱子（金箱需钥匙，掉被动道具或一堆掉落物）
      if (!room.chestSpawned) {
        room.chestSpawned = true;
        const roll = this.rng.frac();
        if (roll < 0.18) this.spawnPickup("goldChest", ROOM.cx - 140, ROOM.cy + 56);
        else if (roll < 0.4) this.spawnPickup("chest", ROOM.cx - 140, ROOM.cy + 56);
      }
    } else if (room.type === "shop") {
      this.spawnShop(room);
    } else if (room.type === "superSecret") {
      this.spawnSuperSecretRoom(room);
    } else if (SECRET_TYPES.has(room.type)) {
      this.spawnHiddenRoom(room);
    } else if (room.type === "devil") {
      this.spawnDevilRoom(room);
    } else if (!room.cleared) {
      // 未清理的房间（含重进）每次都重新刷敌人，与原作一致；场上敌人已在上方清空，不会叠加
      this.seedEnemies(room);
    }

    this.flushActiveDrop();
    MUSIC.setMood(room.type === "boss" && !room.cleared ? "boss" : "normal");
    this.updateHud();
  }

  // 只在有连接的槽位画门（无连接的槽位是封死的完整墙：底图 v9 起全密封无洞）。
  // 门槽按房对象每格外边界中点计（doorSlots）。普通门 = 官方渲染抠图门洞
  // （石门楣+梯形黑隧道，doorHoleKey 按层选），关门再叠程序梯形木板（嵌进隧道口）、
  // 开门加一截房内地板门光；Boss/宝金锁门/恶魔门垫同一门洞后坐官方贴图，
  // 隐藏暗门是墙皮破洞、直接贴官方 secretRoomDoor。
  // 门对象上记录 doorLabel/doorKind/doorSkull，供冒烟测试断言门类型。
  drawDoors(room) {
    const rect = this.roomRect(room);
    const slots = this.doorSlots(room);

    slots.forEach((slot) => {
      // 恶魔门：Boss 清理后一面墙刷出的红门（Room.devilDoor=方向，Boss 房恒 1×1 每墙一槽）；
      // 可能没有真实邻居（北墙"幽灵门"兜底）
      const isDevilDoor = room.devilDoor === slot.label;
      const target = this.rooms.get(`${slot.nx},${slot.ny}`);
      if (!target) {
        if (!isDevilDoor) return; // 无连接：完整墙，不画门
      } else if (SECRET_TYPES.has(target.type) && !target.revealed && !isDevilDoor) {
        return; // 隐藏房未炸开：完整墙
      }
      const door = this.slotDoorRect(slot, rect);
      const g = this.add.graphics();
      g.doorLabel = slot.label;
      g.doorSkull = false;
      const holeKey = this.doorHoleKey();
      if (isDevilDoor) {
        // 恶魔门：原版暗红肉色魔光底衬（原版红门框观感）+ 官方门洞黑隧道 + 恶魔头门楣贴图
        g.fillStyle(0x8a2430, 0.4);
        g.fillEllipse(door.x + door.w / 2, door.y + door.h / 2, 100, 100);
        this.makeDoorSprite(g, door, holeKey, 96);
        this.makeDoorSprite(g, door, "devilDoor", 80);
        g.doorKind = "devil";
      } else if (SECRET_TYPES.has(target.type) || SECRET_TYPES.has(room.type)) {
        // 炸开后的隐藏房/超级隐藏房（两侧视角都是破洞）：官方暗门贴图直接贴墙皮（无门框）
        this.makeDoorSprite(g, door, "secretRoomDoor", 92);
        g.doorKind = "hole";
      } else if (this.isDoorLocked(target)) {
        // 2 层起宝箱房/商店锁门：官方金宝锁门贴图坐进门洞；锁门状态与清房无关，优先展示
        this.makeDoorSprite(g, door, holeKey, 96);
        this.makeDoorSprite(g, door, "treasureDoorLocked", 84);
        g.doorKind = "gold";
      } else if (!room.cleared) {
        // 未清房：官方门洞 + 梯形木板（嵌洞口）；Boss 门坐官方骷髅门贴图
        if (target.type === "boss") {
          this.makeDoorSprite(g, door, holeKey, 96);
          this.makeDoorSprite(g, door, "bossDoor", 88);
        } else {
          this.makeDoorSprite(g, door, holeKey, 96);
          this.drawClosedWood(g, door);
        }
        g.doorKind = "closed";
        g.doorSkull = target.type === "boss";
      } else {
        // 清房后：官方黑暗门洞 + 房内地板门光；宝箱房/Boss 门坐官方门贴图
        if (target.type === "boss") {
          this.makeDoorSprite(g, door, holeKey, 96);
          this.makeDoorSprite(g, door, "bossDoor", 88);
        } else if (target.type === "treasure") {
          this.makeDoorSprite(g, door, holeKey, 96);
          this.makeDoorSprite(g, door, "doorOpen", 88);
        } else {
          this.makeDoorSprite(g, door, holeKey, 96);
          this.drawDoorLight(g, door);
        }
        g.doorKind = "open";
        g.doorSkull = target.type === "boss";
      }
      this.addRoomObject(g, DEPTH.room + 1);
      this.doorGraphics.push(g); // 记录门对象，清房时做开启闪烁反馈
    });
  }

  // 当前楼层的官方门洞贴图（extract-doors.py 从三层官方渲染抠取，石门楣+梯形黑隧道）
  doorHoleKey() {
    if (this.floor === 2) return "doorHoleCaves";
    if (this.floor >= 3) return "doorHoleDepths";
    return "doorHoleBasement";
  }

  // 门贴图落位：原图都是北向（门楣在上、梯形宽口朝房外）；south 垂直翻转、
  // west/east 旋转 ±90°（east +90°：宽口转右/房外；west -90°：宽口转左/房外）。
  // displayW = 北向显示宽（等比缩放，不再拉伸变形）；旋转后宽高自动互换。
  // 贴图 image 与元数据载体 g 都登记进 roomObjects，换房一并销毁。
  makeDoorSprite(g, door, key, displayW = 92) {
    g.doorTexture = key; // 冒烟插桩：记录本门主贴图 key（断言恶魔门走 devilDoor 路径）
    const { x, y, w, h } = door;
    const img = this.add.image(x + w / 2, y + h / 2, key);
    img.setScale(displayW / img.width);
    if (door.label === "east") img.setRotation(Math.PI / 2);
    else if (door.label === "west") img.setRotation(-Math.PI / 2);
    else if (door.label === "south") img.setFlipY(true);
    if (String(key).startsWith("doorHole")) {
      // 冒烟插桩：门洞贴图（北向原图）按槽位的变换去向——宽口必须朝房外
      g.doorHolePose = `${door.label}:rot${img.rotation.toFixed(3)},flipY=${img.flipY}`;
    }
    this.addRoomObject(img, DEPTH.room + 1);
    return img;
  }

  // 关门木板：嵌进门洞黑隧道的梯形板（宽端顶着门楣外的洞口宽口，顺门洞透视向房内收窄），
  // 板缝 + 门闩横杠。门框/石门楣由 doorHole 贴图提供，这里只补板面（官方渲染无关门木门可抠）。
  // 板面几乎塞满洞口（v10 加宽加长：此前 40-64 窄板只盖洞心，四门关闭态被看成"黑洞"）
  drawClosedWood(g, door) {
    const { x, y, w, h, label } = door;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const W_OUT = 76; // 房外端（顶门楣下沿，洞宽口）
    const W_IN = 58; // 房内端（顺透视收窄）
    const LEN = 66; // 轴向长度：外端贴洞口宽口、内端到墙根
    const board = 0x7a4f33; // 板面（原关门棕木，比之前亮一档，洞里可读）
    const seam = 0x3c2418; // 板缝/门闩暗色
    const edge = 0x9a6b4a; // 房内端亮沿
    // 以"房内方向向量 (ox,oy)"把局部梯形摆到四向：局部 (u 宽向, v 轴向朝房内)
    const dirIn = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[label];
    // 垂直于轴的宽向
    const wide = [-dirIn[1], dirIn[0]];
    // 轴心（梯形中段），外端 v0 顶到门洞宽口沿（洞口中心再往外 36px）
    const c0x = cx - dirIn[0] * 3;
    const c0y = cy - dirIn[1] * 3;
    const pt = (wu, v) => [c0x + wide[0] * wu + dirIn[0] * v, c0y + wide[1] * wu + dirIn[1] * v];
    const v0 = -LEN / 2 - 6; // 房外端
    const v1 = LEN / 2 - 6; // 房内端
    const p1 = pt(-W_OUT / 2, v0);
    const p2 = pt(W_OUT / 2, v0);
    const p3 = pt(W_IN / 2, v1);
    const p4 = pt(-W_IN / 2, v1);
    g.fillStyle(board, 1);
    g.fillPoints([p1, p2, p3, p4].map(([px, py]) => new Phaser.Geom.Point(px, py)), true);
    // 外端（门楣下）压暗边，板面沉进洞口
    g.lineStyle(3, seam, 0.85);
    g.lineBetween(p1[0], p1[1], p2[0], p2[1]);
    // 房内端亮沿（洞口气光）
    g.lineStyle(2.5, edge, 0.9);
    g.lineBetween(p4[0], p4[1], p3[0], p3[1]);
    // 板缝：两条沿轴向的缝（1/3、2/3 宽处）
    g.lineStyle(2, seam, 0.95);
    [-1 / 6, 1 / 6].forEach((t) => {
      const o = pt(t * W_OUT, v0 + 3);
      const i = pt(t * W_IN, v1 - 3);
      g.lineBetween(o[0], o[1], i[0], i[1]);
    });
    // 门闩：垂直轴向的横杠，两端铆钉
    const lv = v0 + LEN * 0.5;
    const lwO = W_OUT * 0.5 + (W_IN - W_OUT) * 0.5 + 5;
    const la = pt(-lwO / 2 + 0, lv - 4);
    const lb = pt(lwO / 2, lv - 4);
    const lc = pt(lwO / 2 + 0, lv + 4);
    const ld = pt(-lwO / 2 + 0, lv + 4);
    g.fillStyle(seam, 1);
    g.fillPoints([la, lb, lc, ld].map(([px, py]) => new Phaser.Geom.Point(px, py)), true);
    g.fillStyle(0x2a180e, 1);
    [la, lc].forEach(([px, py]) => g.fillCircle(px + dirIn[0] * 0, py, 2.2));
  }

  // 开门地板门光：房内一侧一段暖色梯形光（原版开门光照进房内的观感）。
  // 近端紧贴门洞隧道口（略压进贴图 2px，杜绝光带与洞口之间的缝）；
  // 分 4 段递减 alpha 渐隐——整片均色会在墙根显出"灰色立板"样的硬边（用户标注贴图错误）
  drawDoorLight(g, door) {
    const LIGHT_INNER_W = 32; // 近端宽（洞口等宽）
    const LIGHT_OUTER_W = 50; // 远端泻光宽
    const STEPS = [0.16, 0.11, 0.06, 0.025]; // 近→远渐隐
    const { x, y, w, h, label } = door;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const dirIn = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[label];
    const wide = [-dirIn[1], dirIn[0]];
    const pt = (wu, v) => [cx + wide[0] * wu + dirIn[0] * v, cy + wide[1] * wu + dirIn[1] * v];
    // 洞口沿轴位置：N/S 门洞贴图洞口贴 rect 边内 ~39px，E/W ~37px；近端收进去 2px
    const d0 = (label === "north" || label === "south" ? 39 : 37) - 2;
    const d1 = d0 + 44;
    for (let k = 0; k < STEPS.length; k += 1) {
      const va = d0 + ((d1 - d0) * k) / STEPS.length;
      const vb = d0 + ((d1 - d0) * (k + 1)) / STEPS.length;
      const wa = LIGHT_INNER_W + ((LIGHT_OUTER_W - LIGHT_INNER_W) * k) / STEPS.length;
      const wb = LIGHT_INNER_W + ((LIGHT_OUTER_W - LIGHT_INNER_W) * (k + 1)) / STEPS.length;
      g.fillStyle(0xffdca0, STEPS[k]);
      g.fillPoints(
        [pt(-wa / 2, va), pt(wa / 2, va), pt(wb / 2, vb), pt(-wb / 2, vb)].map(([px, py]) => new Phaser.Geom.Point(px, py)),
        true,
      );
    }
  }

  // 忏悔锁门规则：宝箱房/商店 1 层免费、2 层起都要 1 钥匙
  isDoorLocked(target) {
    return (
      this.floor > 1 &&
      (target.type === "treasure" || target.type === "shop") &&
      !target.unlocked
    );
  }

  floorTheme() {
    return FLOOR_THEMES[Math.min(this.floor, MAX_FLOOR)] || FLOOR_THEMES[1];
  }

  // 两个 0xRRGGBB 颜色按 t 插值，用于楼层主题与房型 tint 混合
  mixColors(a, b, t = 0.5) {
    const ar = (a >> 16) & 255;
    const ag = (a >> 8) & 255;
    const ab = a & 255;
    const br = (b >> 16) & 255;
    const bg = (b >> 8) & 255;
    const bb = b & 255;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }

  // 通用血带横幅：滴血暗红横带横跨画面，白色粗体主标题 + 小字副标题，淡入→停留→淡出
  // 楼层名/道具拾取用默认下三分之一位置，Boss 名可传更高位置；同时只保留一条
  showBloodBanner(title, subtitle = "", y = HEIGHT * 0.72) {
    if (this.bloodBanner) {
      this.bloodBanner.destroy();
      this.bloodBanner = null;
    }
    const bandW = ROOM.right - ROOM.left + 48;
    const bandH = subtitle ? 64 : 50;
    const g = this.add.graphics();
    // 暗红主带 + 上缘亮血线
    g.fillStyle(0x4d0b0b, 0.94);
    g.fillRect(-bandW / 2, -bandH / 2, bandW, bandH);
    g.fillStyle(0x7c1717, 0.9);
    g.fillRect(-bandW / 2, -bandH / 2, bandW, 5);
    // 下缘滴血垂坠：一排水滴状小柱 + 圆头，两端再甩几滴
    for (let x = -bandW / 2 + 8; x < bandW / 2 - 10; x += this.rng.between(12, 30)) {
      const w = this.rng.between(4, 9);
      const len = this.rng.between(5, 19);
      g.fillStyle(0x4d0b0b, 0.94);
      g.fillRect(x, bandH / 2, w, len);
      g.fillCircle(x + w / 2, bandH / 2 + len, w / 2);
    }
    const titleText = this.add
      .text(0, subtitle ? -13 : 0, title, {
        fontFamily: "Arial, sans-serif",
        fontSize: "34px",
        fontStyle: "bold",
        color: "#ffffff",
        stroke: "#2a0505",
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    const parts = [g, titleText];
    if (subtitle) {
      parts.push(
        this.add
          .text(0, 19, subtitle, {
            fontFamily: "Arial, sans-serif",
            fontSize: "17px",
            fontStyle: "bold",
            color: "#f2e3d2",
            stroke: "#2a0505",
            strokeThickness: 4,
          })
          .setOrigin(0.5),
      );
    }
    const banner = this.add.container(WIDTH / 2, y, parts);
    banner.setDepth(DEPTH.overlay + 2).setAlpha(0).setScrollFactor(0); // 血横幅钉屏
    this.bloodBanner = banner;
    this.tweens.add({
      targets: banner,
      alpha: 1,
      duration: 280,
      yoyo: true,
      hold: 1150,
      onComplete: () => {
        if (this.bloodBanner === banner) this.bloodBanner = null;
        banner.destroy();
      },
    });
  }

  // Boss 出场横幅：血带（Boss 名 + VS 副标题）+ 吼叫
  showBossBanner(name) {
    SFX.play("roar");
    this.showBloodBanner(name, "VS", HEIGHT * 0.42);
  }

  seedEnemies(room) {
    const count = room.type === "boss" ? 1 : this.rng.between(4, 7) + Math.min(3, this.floor - 1);
    let placed = 0;
    // 模板站位标记优先落位；标记怪种若不在本层敌人池则回退池内随机（保楼层节奏）；
    // 离玩家进房点过近的标记放弃（改由随机补位）
    (room.markedSpawns || []).forEach((mark) => {
      if (placed >= count) return;
      if (Phaser.Math.Distance.Between(mark.x, mark.y, this.player.x, this.player.y) < 120) return;
      const pool = this.enemyPool();
      const type = pool.includes(mark.type) ? mark.type : this.rng.pick(pool);
      this.spawnEnemy(type, mark.x, mark.y, {});
      placed += 1;
    });
    const scatterRect = this.roomRect(room);
    for (let i = placed; i < count; i += 1) {
      const type = room.type === "boss" ? "boss" : this.rng.pick(this.enemyPool());
      const radius = type === "boss" ? 70 : 36;
      // 撒点范围 = 全房格子并集（大房即整房外接矩形）
      const x = this.rng.between(scatterRect.left + 70, scatterRect.right - 70);
      const y = this.rng.between(scatterRect.top + 64, scatterRect.bottom - 64);
      if (
        Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) < 140 ||
        this.isBlockedSpawn(x, y, radius) ||
        this.nearDoorBand(x, y)
      ) {
        i -= 1;
        continue;
      }
      this.spawnEnemy(type, x, y, room.type === "boss" ? { bossKind: room.bossKind } : {});
    }
    if (room.type === "boss") {
      this.showBossBanner(BOSS_NAMES[room.bossKind] || "Boss");
    }
  }

  // 门口 1.2 格安全带：随机刷怪避开各门槽的行进线（模板格已由模板注释保证）；
  // 大房逐槽位判定（内部格间界无槽位，跨缝照常可刷）
  nearDoorBand(x, y) {
    const room = this.getRoom();
    const rect = (this.curRoom === room && this.curRect) || this.roomRect(room);
    const slots = (this.curRoom === room && this.curSlots) || this.doorSlots(room);
    const laneW = (CELL_W / TEMPLATE_COLS) * 1.2;
    const laneH = (CELL_H / TEMPLATE_ROWS) * 1.2;
    return slots.some((slot) => {
      if (slot.label === "north") return Math.abs(x - slot.cx) < laneW && y < rect.top + laneH * 2;
      if (slot.label === "south") return Math.abs(x - slot.cx) < laneW && y > rect.bottom - laneH * 2;
      if (slot.label === "west") return Math.abs(y - slot.cy) < laneH && x < rect.left + laneW * 2;
      return Math.abs(y - slot.cy) < laneH && x > rect.right - laneW * 2;
    });
  }

  enemyPool() {
    return this.floorTheme().pool;
  }

  isBlockedSpawn(x, y, radius) {
    return this.obstacleZones.some((zone) => Phaser.Math.Distance.Between(x, y, zone.x, zone.y) < radius + zone.radius);
  }

  spawnEnemy(type, x, y, options = {}) {
    // Boss 种类：房间生成时已记入 room.bossKind（Boss 池），缺省按楼层兜底
    const bossKind = type === "boss" ? options.bossKind || (this.floor >= MAX_FLOOR ? "mom" : this.floor === 2 ? "twins" : "monstro") : null;
    // 萌死戳形象固定为 Kimi 蓝圆球（用户指定；官方 monstro 贴图仅作加载保留，行为完全一致，三连帧由 setMonstroFace 切换）
    const easterEgg = type === "boss" && bossKind === "monstro" && !options.texture;
    const texture = options.texture || (easterEgg ? "kimiBoss" : type === "boss" ? BOSS_TEXTURES[bossKind] || SPRITES.boss : SPRITES[type] || type);
    const enemy = this.physics.add.sprite(x, y, texture);
    const floorHp = 1 + (this.floor - 1) * 0.35;
    const floorSpeed = 1 + (this.floor - 1) * 0.07;
    // 显示尺寸按 v9 帧实测校准（BV1c2Tu6EEtv/BV18mjp64EuK 960×540 帧内 bbox ×1.136
    // 换算：帧≈1.76×原版原生、游戏=2×原生；玩家 52 锁定为锚。实测样本：
    // horf 净体 43→49（f_0149）、fly 28→32（f_0329）、AttFly 同帧、monstro 趴 153→174（f_0045）；
    // 无帧样本的按原生×2：gaper 24→48、host 26→52、spider 16→26、pooter 18→36、
    // hopper 19→38、bigSpider 20→40、sucker 16→32、boomFly≈苍蝇 1.5 倍→46、mulligan 23→48；
    // crawler/mulligan 贴图竖长（28×33/34×36），size 是 max-维基准，净显示宽 = size×w/h
    const base = {
      crawler: { hp: 2.4, speed: 105, size: 56 },
      horf: { hp: 3.0, speed: 0, size: 49 },
      host: { hp: 3.4, speed: 0, size: 52 },
      pooter: { hp: 1.2, speed: 70, size: 36 },
      hopper: { hp: 2.0, speed: 0, size: 38 },
      spider: { hp: 1.5, speed: 128, size: 26 },
      bigSpider: { hp: 2.6, speed: 104, size: 40 },
      boomFly: { hp: 2.4, speed: 148, size: 46 },
      sucker: { hp: 2.0, speed: 40, size: 32 },
      mulligan: { hp: 2.8, speed: 76, size: 48 },
      fly: { hp: 1.4, speed: 148, size: 32 },
      charger: { hp: 3.8, speed: 56, size: 46 },
      bossSmall: { hp: 12, speed: 148, size: 56 },
      boss: { hp: 24 * (1 + (this.floor - 1) * 0.55), speed: 62 + (this.floor - 1) * 7, size: 130 },
    }[type];
    // Boss 按种类定显示尺寸（帧实测：萌死戳≈174 / 双子大≈112 / 粪山≈110 / 古迪≈130 / 妈腿≈170）
    const bossSize = type === "boss" ? BOSS_SIZES[bossKind] || base.size : base.size;
    enemy.kind = type;
    enemy.uid = this.enemySeq += 1;
    enemy.hp = type === "boss" ? base.hp : base.hp * floorHp;
    enemy.maxHp = enemy.hp;
    enemy.speed = type === "boss" ? base.speed : base.speed * floorSpeed;
    enemy.touch = type === "boss" ? 2 : 1;
    enemy.nextShot = this.time.now + this.rng.between(500, 1400);
    enemy.phaseAt = this.time.now + this.rng.between(900, 1600);
    enemy.state = "roam";
    enemy.summonAt = this.time.now + 5200;
    enemy.baseTint = options.tint || null;
    enemy.easterEgg = easterEgg;
    // 飞行怪越过障碍（collider 的 process 回调读此标记）；站桩怪不吃击退；
    // Host 原版无接触伤害；Boss 召唤物不参与软推挤
    enemy.flying = ENEMY_FLYING.has(enemy.kind);
    enemy.noKnock = ["horf", "host"].includes(enemy.kind);
    enemy.noTouchDamage = enemy.kind === "host";
    enemy.noPush = Boolean(options.noPush) || ["horf", "host"].includes(enemy.kind);
    enemy.setDepth(DEPTH.actor);
    this.fitDisplaySize(enemy, options.size || bossSize);
    if (options.tint) enemy.setTint(options.tint);
    this.enemies.add(enemy);
    const bodyRadius = Math.min(enemy.width, enemy.height) * (type === "boss" ? 0.42 : 0.36);
    enemy.setCircle(bodyRadius, (enemy.width - bodyRadius * 2) / 2, (enemy.height - bodyRadius * 2) / 2);
    // 泪弹地面投影判定用世界像素半径（照妖镜：大图贴图源像素 ≠ 世界像素，乘显示缩放换算）
    enemy.hitRadius = bodyRadius * enemy.scaleX;
    enemy.baseDisplaySize = options.size || bossSize;

    // 精英：按原版三色语义抽色（红/蓝/黑），10% 稀有金色超级精英（更硬、双倍掉落）
    if (type !== "boss" && !options.noChampion && this.rng.frac() < 0.08 + this.floor * 0.03) {
      const roll = this.rng.frac();
      this.applyChampion(enemy, roll < 0.1 ? "gold" : roll < 0.4 ? "red" : roll < 0.7 ? "blue" : "black");
    }

    if (type === "boss") {
      // 按 bossKind 分派变体：萌死戳/双子/妈腿/粪山/古迪；Boss 不吃 champion
      const variant = BOSS_VARIANTS[bossKind] || 1;
      enemy.bossKind = bossKind;
      enemy.bossVariant = variant;
      enemy.jumpAt = this.time.now + this.rng.between(2600, 4600);
      if (variant === 1) {
        // 萌死戳：官方抠图帧（196×152 本体）；彩蛋是 Kimi 球（100×100 脸半径 42）。
        // 判定圈按贴图比例与体缘对齐（hitRadius 换算成世界像素）
        const r = Math.min(enemy.width, enemy.height) * 0.42;
        enemy.setCircle(r, (enemy.width - r * 2) / 2, (enemy.height - r * 2) / 2);
        enemy.hitRadius = r * enemy.scaleX;
      } else if (variant === 2) {
        enemy.hp = 26 * (1 + (this.floor - 1) * 0.55);
        enemy.maxHp = enemy.hp;
        enemy.speed = 46;
        const twin = this.spawnEnemy("bossSmall", x + 90, y + 40, { noChampion: true, texture: "geminiSmall", size: 56 });
        twin.twinLeader = enemy;
        enemy.twin = twin;
        enemy.totalMaxHp = enemy.maxHp + twin.maxHp;
      } else if (variant === 3) {
        // 妈腿：平时隐身不可击中，踩下时露出攻击窗口。
        // 官方精灵 215x440（裙摆在上、高跟在下）：原点移到鞋跟着地点 (~0.395,0.998)，
        // enemy 坐标即踩落点；判定圈只包住高跟（贴图中心 (82,397) 半径 47），泪弹判定 30
        enemy.hp = 42 * (1 + (this.floor - 1) * 0.55);
        enemy.maxHp = enemy.hp;
        enemy.speed = 0;
        enemy.bossState = "idle";
        enemy.nextStomp = this.time.now + 2600;
        enemy.airborne = true;
        this.fitDisplaySize(enemy, 180);
        enemy.setOrigin(0.395, 0.998);
        enemy.setCircle(47, 35, 350);
        enemy.hitRadius = 30;
        enemy.body.enable = false;
        enemy.setAlpha(0.18);
        enemy.setPosition(this.curRect.cx, this.curRect.top + 46);
      } else if (variant === 4) {
        // 粪山：官方 dingle 造型（棕色便便山长眼嘴），缓慢追人 + 三连冲撞；血量与萌死戳同级
        enemy.hp = 24 * (1 + (this.floor - 1) * 0.55);
        enemy.maxHp = enemy.hp;
        enemy.speed = 52;
        enemy.phaseAt = this.time.now + this.rng.between(2000, 3000);
        enemy.summonAt = this.time.now + 4600;
      } else if (variant === 5) {
        // 古迪：官方 gurdy 大肉山，房间中央站桩，扇形/径向弹幕 + 召苍蝇
        enemy.hp = 28 * (1 + (this.floor - 1) * 0.55);
        enemy.maxHp = enemy.hp;
        enemy.speed = 0;
        enemy.setPosition(this.curRect.cx, this.curRect.cy - 24);
        enemy.nextShot = this.time.now + 1500;
        enemy.summonAt = this.time.now + 3800;
      }
      this.makeBossBar(enemy, BOSS_NAMES[bossKind] || "Boss");
    }

    enemy.baseScaleX = enemy.scaleX;
    enemy.baseScaleY = enemy.scaleY;
    enemy.spawnAnim = 0;
    enemy.setScale(enemy.baseScaleX * 0.05, enemy.baseScaleY * 0.05);
    return enemy;
  }

  // 精英怪着色（原版语义）：红 hp×2.6 掉红心 / 蓝 hp×2.2 掉魂心 / 黑 hp×2.2 掉炸弹 / 金稀有 ×3 双倍掉落；
  // 掉落结算在 damageEnemy 死亡分支按 championColor 取 CHAMPION_TYPES.drop
  applyChampion(enemy, color) {
    const def = CHAMPION_TYPES[color] || CHAMPION_TYPES.gold;
    enemy.isChampion = true;
    enemy.championColor = color;
    enemy.hp *= def.hpMul;
    enemy.maxHp = enemy.hp;
    enemy.speed *= 0.92;
    this.fitDisplaySize(enemy, enemy.baseDisplaySize * def.scale);
    enemy.baseTint = def.tint;
    enemy.setTint(def.tint);
  }

  // Boss 血条组件：底部居中横条（深底描边 + 红色填充）+ Boss 名，对齐原作感觉；钉屏
  makeBossBar(enemy, name) {
    const bar = this.add.graphics();
    bar.setDepth(DEPTH.ui).setScrollFactor(0);
    enemy.bar = bar;
    enemy.barLabel = this.add
      .text(WIDTH / 2, 480, name, {
        fontFamily: "Arial, sans-serif",
        fontSize: "16px",
        fontStyle: "bold",
        color: "#f0dcd8",
        stroke: "#1a0a0c",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.ui)
      .setScrollFactor(0);
  }

  // 目击道具过滤：优先从"没见过的道具"里抽，池子抽空时回退全池（防死循环）
  pickFromPool(pool) {
    const fresh = pool.filter((item) => !this.seenItems.has(item.name));
    return this.rng.pick(fresh.length ? fresh : pool);
  }

  // 石墩柱式底座（对齐原版 pedestal 观感）：地面阴影椭圆 + 上窄下宽收分石柱 + 圆角石顶板。
  // (x, plateTop) 顶板上沿中线；scale=1 总高约 46px（顶板 44 宽），商店用 ~0.85 小号
  drawStonePedestal(x, plateTop, scale = 1) {
    const stand = this.add.graphics();
    const w = 44 * scale;
    const colH = 24 * scale;
    // 地面投影
    stand.fillStyle(0x101010, 0.32);
    stand.fillEllipse(x, plateTop + colH + 16 * scale, (w + 14 * scale) * 1.15, 13 * scale);
    // 收分石柱（上窄下宽，右侧面压暗出体积）
    const cwTop = 26 * scale;
    const cwBot = 33 * scale;
    const y0 = plateTop + 9 * scale;
    const y1 = y0 + colH;
    stand.fillStyle(0x635950, 1);
    stand.fillPoints(
      [
        new Phaser.Geom.Point(x - cwTop / 2, y0),
        new Phaser.Geom.Point(x + cwTop / 2, y0),
        new Phaser.Geom.Point(x + cwBot / 2, y1),
        new Phaser.Geom.Point(x - cwBot / 2, y1),
      ],
      true,
    );
    stand.fillStyle(0x4c443d, 0.92);
    stand.fillPoints(
      [
        new Phaser.Geom.Point(x + cwTop / 2 - 7 * scale, y0),
        new Phaser.Geom.Point(x + cwTop / 2, y0),
        new Phaser.Geom.Point(x + cwBot / 2, y1),
        new Phaser.Geom.Point(x + cwBot / 2 - 8 * scale, y1),
      ],
      true,
    );
    // 顶板（圆角石板 + 上缘亮沿）
    stand.fillStyle(0x7a6f66, 1);
    stand.fillRoundedRect(x - w / 2, plateTop, w, 12 * scale, 5 * scale);
    stand.fillStyle(0x8d8278, 1);
    stand.fillRoundedRect(x - w / 2 + 3 * scale, plateTop + 1.5 * scale, w - 6 * scale, 3 * scale, 1.5 * scale);
    return stand;
  }

  spawnItemPedestal(room) {
    if (room.itemTaken) return;
    if (!room.item) {
      room.item = this.pickFromPool(ITEM_POOL);
    }
    this.seenItems.add(room.item.name); // 进房看见即"目击"，不再进后续抽取池
    const stand = this.drawStonePedestal(ROOM.cx, ROOM.cy + 12, 1);
    stand.lineStyle(3, 0xf4efe4, 0.75);
    stand.strokeCircle(ROOM.cx, ROOM.cy - 12, 28); // 道具圣光圆环
    this.addRoomObject(stand, DEPTH.pickup - 1);

    const icon = this.add.image(ROOM.cx, ROOM.cy - 12, room.item.iconFrame);
    this.fitDisplaySize(icon, 58);
    this.addRoomObject(icon, DEPTH.pickup);
    // 呼吸感：道具贴图轻微上下浮动（drawRoom 清理时会先 killTweensOf）
    this.tweens.add({ targets: icon, y: icon.y - 6, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });

    const pickup = this.physics.add.sprite(ROOM.cx, ROOM.cy - 12, room.item.iconFrame);
    this.fitDisplaySize(pickup, 58);
    pickup.setAlpha(0.01);
    pickup.kind = "item";
    pickup.item = room.item;
    pickup.room = room;
    pickup.setDepth(DEPTH.pickup);
    this.pickups.add(pickup);
    const grab = Math.min(pickup.width, pickup.height) * 0.35;
    pickup.body.setCircle(grab, (pickup.width - grab * 2) / 2, (pickup.height - grab * 2) / 2);
  }

  // 捐款机商店等级：本局累计每 5¢ 升 1 级（0→2 件、1→3 件、≥2→4 件；封顶 2 级，不持久化到存储）
  shopLevel() {
    return Math.min(2, Math.floor(this.shopDonated / 5));
  }

  // 商店商品数据（与视觉分离，冒烟可直接断言）：按商店等级出 2/3/4 件。
  // 45% 道具（15¢；忏悔规则：2 层起 20% 概率按主动位 10¢），55% 拾取物（SHOP_OFFERS 原版定价表）；
  // 约 15% 商品抽中红字半价签（价格减半向上取整，15→8 记 "SALE!"）
  buildShopStock(room) {
    if (room.shopStock) return room.shopStock;
    const slots = 2 + this.shopLevel();
    const debugParams = new URLSearchParams(location.search);
    room.shopStock = [];
    for (let i = 0; i < slots; i += 1) {
      let slot;
      if (this.rng.frac() < 0.45) {
        const item = this.pickFromPool(ITEM_POOL);
        let price = 15;
        if (this.floor >= 2 && item.type === "active" && this.rng.frac() < 0.2) price = 10;
        slot = { kind: "item", item, name: null, price, bought: false };
      } else {
        slot = { ...this.rng.pick(SHOP_OFFERS), bought: false };
      }
      // ?sale=1：截图调试，强制 0 号商品半价
      if (this.rng.frac() < 0.15 || (i === 0 && debugParams.get("sale"))) {
        slot.sale = true;
        slot.price = Math.ceil(slot.price / 2);
      }
      room.shopStock.push(slot);
    }
    // 地面散币（原版商店常见）：55% 概率 1 枚、其中 25% 概率再追加 1 枚
    room.shopScatter = this.rng.frac() < 0.55 ? (this.rng.frac() < 0.25 ? 2 : 1) : 0;
    // 店主款型：10% 特殊店主（炸毁掉落加成：50% 额外 2 币，见 explodeAt）
    room.keeperKind = this.rng.frac() < 0.1 ? "special" : "normal";
    return room.shopStock;
  }

  spawnShop(room) {
    this.buildShopStock(room);

    // 原版商店地板 = 当前层普通地板（帧 f_0506/f_0541 实测房内零障碍零装饰），不铺地毯/不加染色

    // 店主 NPC：官方吊挂店主贴图（吊绳骷髅木乃伊 28×74），吊在北墙正中、吊绳收进顶墙内；
    // 若北墙开的是本店入口门（门洞贴图与吊绳同位叠穿），避让到门侧（原版店主贴北墙挂饰）。
    // 尺寸对齐帧实测（f_0329：含绳全身约 100+px，此前 66px 明显偏小；special 款同贴图同尺寸）
    const northSlot = this.doorSlots(room).find((slot) => slot.label === "north");
    const northOpen = northSlot && this.rooms.get(`${northSlot.nx},${northSlot.ny}`);
    const keeper = this.add.image(northOpen ? ROOM.cx - 112 : ROOM.cx, ROOM.top + 36, room.keeperKind === "special" ? "shopkeeperSpecial" : "shopkeeper");
    keeper.setDisplaySize(Math.round((100 * 28) / 74), 100);
    keeper.special = room.keeperKind === "special";
    this.addRoomObject(keeper, DEPTH.pickup - 1);
    this.shopkeepers.push(keeper);

    // 捐款机：北墙中偏左灰色小机器（帧 f_0329 实测 cx-136、半嵌顶墙）；走近撞上自动捐 1¢
    // （800ms 冷却）；原版机器上无常驻等级大字，Lv 只在捐赠 toast 里报
    const machine = this.physics.add.staticImage(ROOM.cx - 136, ROOM.top + 6, "donation");
    this.fitDisplaySize(machine, 54);
    machine.refreshBody();
    this.addRoomObject(machine, DEPTH.pickup - 1);
    this.donationCollider = this.physics.add.collider(this.player, machine, this.touchDonationMachine, null, this);

    // 地面散币（帧 f_0506 实测散在房间右下带）：只首次进房刷一次（未捡的交给 groundDrops 持久化）
    if (!room.scatterSpawned) {
      room.scatterSpawned = true;
      for (let i = 0; i < room.shopScatter; i += 1) {
        this.spawnPickup("coin", ROOM.cx + 96 + i * 30, ROOM.cy + 92 + i * 18);
      }
    }

    // 商品（帧 f_0506/f_0541 实测槽位）：
    // 底排（≤3 件全在底排）：图标中心 cy+26、石墩柱式底座（顶板贴图标底沿）、价签中心 cy+80，
    // 间距 104（2 格）；2 级 4 件时第 3/4 件上北排（同 x、整排上移 142，盲盒 ??? 实测在北排）。
    // 价签字号 27px 贴原版手写大签（"15¢" 帧测字高约 24px）；白=原价、红=半价 SALE!
    const spacing = 104;
    room.shopStock.forEach((slot, index) => {
      if (slot.bought) return;
      const inTopRow = room.shopStock.length > 3 && index >= 2;
      const rowIndex = inTopRow ? index - 2 : index;
      const rowCount = inTopRow ? room.shopStock.length - 2 : Math.min(room.shopStock.length, 3);
      const x = ROOM.cx - ((rowCount - 1) * spacing) / 2 + rowIndex * spacing;
      const iconY = inTopRow ? ROOM.cy - 100 : ROOM.cy + 26;
      const labelY = iconY + 54;
      if (slot.kind === "item") this.seenItems.add(slot.item.name); // 目击登记

      // 石墩柱式底座（阴影+收分石柱+顶板，帧 f_0506 顶板呈贴地灰盘）：只有道具类摆底座；
      // 心/炸弹/卡牌等拾取物商品直接悬地（帧 f_0329 红心 15¢、f_0509 红心 3¢ 均无底座）
      if (slot.kind === "item") {
        const stand = this.drawStonePedestal(x, iconY + 15, 0.85);
        this.addRoomObject(stand, DEPTH.pickup - 1);
        slot.stand = stand;
      }

      const texture = slot.kind === "item" ? slot.item.iconFrame : this.pickupTexture(slot.kind);
      const icon = this.physics.add.sprite(x, iconY, texture);
      icon.kind = "shopItem";
      icon.item = slot.kind === "item" ? slot.item : null;
      icon.slot = slot;
      this.fitDisplaySize(icon, 40);
      icon.setDepth(DEPTH.pickup);
      this.pickups.add(icon);
      const grab = Math.min(icon.width, icon.height) * 0.35;
      icon.body.setCircle(grab, (icon.width - grab * 2) / 2, (icon.height - grab * 2) / 2);

      if (slot.sale) {
        const saleTag = this.add
          .text(x, iconY - 32, "SALE!", {
            fontFamily: "Arial, sans-serif",
            fontSize: "16px",
            fontStyle: "bold",
            color: "#ff6666",
            stroke: "#1a0a0c",
            strokeThickness: 3,
          })
          .setOrigin(0.5);
        this.addRoomObject(saleTag, DEPTH.ui - 1);
        slot.saleTag = saleTag;
      }
      const label = this.add
        .text(x, labelY, `${slot.price}¢`, {
          fontFamily: "Arial, sans-serif",
          fontSize: "27px",
          fontStyle: "bold",
          color: slot.sale ? "#ff6666" : "#f4efe4", // 原版：普通价白字、打折价红字
          stroke: "#1a120a",
          strokeThickness: 4,
        })
        .setOrigin(0.5, 0.5);
      this.addRoomObject(label, DEPTH.ui - 1);
      slot.label = label;
    });
  }

  // 捐款机：撞上即捐 1¢（800ms 冷却，金币 >0 才可），本局每 5¢ 商店升 1 级；不爆炸、不持久化
  touchDonationMachine(player, machine) {
    if (this.time.now < this.lastMoveAt + 500) return; // 进房瞬间路过不算
    if (this.time.now < (machine.cooldownUntil || 0)) return;
    machine.cooldownUntil = this.time.now + 800;
    if (this.playerStats.coins <= 0) {
      this.showToast("没有金币能投进捐款机");
      return;
    }
    this.playerStats.coins -= 1;
    this.shopDonated += 1;
    SFX.play("coin");
    const level = this.shopLevel();
    const previous = Math.floor((this.shopDonated - 1) / 5);
    this.showToast(level > previous ? `捐款机升到 Lv.${level}：商店会多摆一件商品` : "向捐款机投入 1 枚金币");
    this.updateHud();
  }

  // 权重表不放回抽 n 组（原版隐藏房=几种固定内容组合，一房内组类不重复）；返回 kind 数组
  rollLootTable(table, n) {
    const pool = table.slice();
    const picked = [];
    for (let i = 0; i < n && pool.length; i += 1) {
      const total = pool.reduce((sum, entry) => sum + entry[1], 0);
      let roll = this.rng.frac() * total;
      let index = 0;
      for (; index < pool.length; index += 1) {
        roll -= pool[index][1];
        if (roll <= 0) break;
      }
      picked.push(pool.splice(Math.min(index, pool.length - 1), 1)[0][0]);
    }
    return picked;
  }

  // 普通隐藏房内装（原版权重表 HIDDEN_LOOT_TABLE，roll 2-3 组）：
  // 内容只在首次进房掉一次（looted，原版即如此）；道具底座走 itemTaken，重进没捡仍在
  spawnHiddenRoom(room) {
    this.spawnSecretRoomCorpse(room);
    if (!room.looted) {
      room.looted = true;
      const groups = this.rollLootTable(HIDDEN_LOOT_TABLE, this.rng.between(2, 3));
      if (groups.includes("item")) room.item = this.pickFromPool(SECRET_POOL);
      // 道具底座是房间视觉锚点（正中），其余内容组沿中下带横排
      const others = groups.filter((kind) => kind !== "item");
      others.forEach((kind, i) => {
        const x = ROOM.cx + (i - (others.length - 1) / 2) * 170;
        this.spawnSecretRoomGroup(kind, x, ROOM.cy + 88);
      });
    }
    if (room.item) this.spawnItemPedestal(room);
  }

  // 超级隐藏房内装（原版偏补给，SUPER_SECRET_LOOT_TABLE，roll 1-2 组，永不出道具）
  spawnSuperSecretRoom(room) {
    this.spawnSecretRoomCorpse(room);
    if (!room.looted) {
      room.looted = true;
      const groups = this.rollLootTable(SUPER_SECRET_LOOT_TABLE, this.rng.between(1, 2));
      groups.forEach((kind, i) => {
        const x = ROOM.cx + (i - (groups.length - 1) / 2) * 170;
        // 超隐的魂心组出 1-2 颗（普通隐藏房固定 2 颗）
        this.spawnSecretRoomGroup(kind, x, ROOM.cy + 88, kind === "souls" ? this.rng.between(1, 2) : 0);
      });
    }
  }

  // 一组隐藏房内容的实际摆放：以 (x, y) 为锚点
  spawnSecretRoomGroup(kind, x, y, soulCount = 2) {
    if (kind === "coins") {
      // 硬币堆：5-8 枚 penny 朝上半个圆弧散开
      const n = this.rng.between(5, 8);
      for (let i = 0; i < n; i += 1) {
        const angle = Phaser.Math.DegToRad(this.rng.between(-165, -15));
        const r = this.rng.between(16, 46);
        this.spawnPickup("coin", x + Math.cos(angle) * r, y + Math.sin(angle) * r + 24);
      }
    } else if (kind === "boxKey") {
      this.spawnPickup("chest", x - 18, y);
      this.spawnPickup("key", x + 34, y + 16);
    } else if (kind === "redChest") {
      this.spawnPickup("redChest", x, y);
    } else if (kind === "souls") {
      for (let i = 0; i < soulCount; i += 1) {
        this.spawnPickup("soulHeart", x + (i - (soulCount - 1) / 2) * 52, y);
      }
    } else if (kind === "pillcard") {
      this.spawnPickup("pill", x - 22, y);
      this.spawnPickup("card", x + 22, y);
    } else if (kind === "bombs") {
      for (let i = 0; i < 3; i += 1) this.spawnPickup("bomb", x - 32 + i * 32, y);
    }
  }

  // 隐藏房店主尸体彩蛋（原版 Secret Room 大概率有可炸的店主尸体）：25% 出现，
  // 吊挂在房间中央偏上，两侧一对火堆（对齐官方布局 SecretRoom_0）；炸掉掉 1-3 币（见 explodeAt）
  spawnSecretRoomCorpse(room) {
    if (room.corpseGone) return;
    if (room.hasCorpse === undefined) room.hasCorpse = this.rng.frac() < 0.25;
    if (!room.hasCorpse) return;
    const corpse = this.add.image(ROOM.cx, ROOM.top + 48, "shopkeeper");
    corpse.setDisplaySize(Math.round((84 * 28) / 74), 84); // 与商店店主同贴图，尺寸同步加大
    this.addRoomObject(corpse, DEPTH.pickup - 1);
    corpse.secretCorpse = true;
    corpse.room = room;
    this.shopkeepers.push(corpse);
    // 双火堆是装饰性固定陈设（free=true 跳过门口保留区检查：尸体+火贴北墙顶排，不受门巷限制）
    [-1, 1].forEach((side) => this.placeObstacle("candle", ROOM.cx + side * 64, ROOM.top + 58, this.rng, true));
  }

  // 可被恶魔门借用的门洞方向：有真实邻居、非未揭示隐藏房、非锁门；返回方向 label 数组
  devilDoorCandidates(room) {
    return [
      { dx: 0, dy: -1, label: "north" },
      { dx: 0, dy: 1, label: "south" },
      { dx: -1, dy: 0, label: "west" },
      { dx: 1, dy: 0, label: "east" },
    ]
      .filter(({ dx, dy }) => {
        const target = this.rooms.get(`${room.x + dx},${room.y + dy}`);
        if (!target) return false;
        if (SECRET_TYPES.has(target.type) && !target.revealed) return false;
        if (this.isDoorLocked(target)) return false;
        return true;
      })
      .map(({ label }) => label);
  }

  spawnBossReward(room, forceDevil = false) {
    if (!room.bossRewardReady) {
      room.bossRewardReady = true;
      room.item = this.pickFromPool(ITEM_POOL);
      this.spawnPickup("soulHeart", ROOM.cx - 74, ROOM.cy - 48);
      for (let i = 0; i < 4; i += 1) {
        this.spawnPickup("coin", ROOM.cx - 120 + i * 24, ROOM.cy + 52);
      }
      // 恶魔门（概率 40%+每层 8%）：Boss 房一面有连接的门洞标记为红门；
      // 没有合格邻居门时退化为北墙"幽灵门"。本层内持久，换层随 buildMap 重摇清空
      const forced = forceDevil || new URLSearchParams(location.search).get("devil");
      if (forced || this.rng.frac() < 0.4 + this.floor * 0.08) {
        const candidates = this.devilDoorCandidates(room);
        room.devilDoor = candidates.length ? this.rng.pick(candidates) : "north";
      }
    }
    this.spawnItemPedestal(room);
    this.spawnFloorExit(room);
  }

  spawnFloorExit(room) {
    const exit = this.physics.add.sprite(ROOM.cx, ROOM.cy + 126, "floorExit");
    exit.kind = "floorExit";
    exit.room = room;
    exit.armed = false; // 防误触：玩家须先离开过触发区一次（见 updateExitArming）
    exit.setDisplaySize(72, 54);
    exit.setDepth(DEPTH.pickup - 2);
    this.floorExits.add(exit);
    exit.body.setCircle(80, 48, 56);

    const label = this.add
      .text(ROOM.cx, ROOM.cy + 162, this.floor >= MAX_FLOOR ? "离开地窖" : "下一层", {
        fontFamily: "Arial, sans-serif",
        fontSize: "18px",
        color: "#fff0c6",
      })
      .setOrigin(0.5);
    this.addRoomObject(label, DEPTH.ui - 1);
  }

  spawnDevilRoom(room) {
    if (!room.devilStock) {
      // 目击过滤：优先摆没见过的交易；未见过的不凑两样时回退全池
      const fresh = DEVIL_POOL.filter((deal) => !this.seenItems.has(deal.name));
      const pool = fresh.length >= 2 ? [...fresh] : [...DEVIL_POOL];
      room.devilStock = [0, 1].map(() => {
        const index = this.rng.between(0, pool.length - 1);
        const deal = pool.splice(index, 1)[0];
        return { ...deal, taken: false };
      });
    }

    // 恶魔房氛围：整体压暗，顶部中央撒旦雕像剪影 + 两侧各一团火
    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.42);
    dim.fillRect(0, 0, WIDTH, HEIGHT);
    this.addRoomObject(dim, DEPTH.backdrop + 1);

    const statue = this.add.graphics();
    const sx = ROOM.cx;
    const sy = ROOM.top + 58;
    statue.fillStyle(0x0b0709, 0.95);
    // 双翼（外张三角）
    statue.fillTriangle(sx - 8, sy + 8, sx - 116, sy - 32, sx - 32, sy + 42);
    statue.fillTriangle(sx + 8, sy + 8, sx + 116, sy - 32, sx + 32, sy + 42);
    // 身体（梯形）
    statue.fillPoints(
      [new Phaser.Geom.Point(sx - 24, sy + 8), new Phaser.Geom.Point(sx + 24, sy + 8), new Phaser.Geom.Point(sx + 36, sy + 80), new Phaser.Geom.Point(sx - 36, sy + 80)],
      true,
    );
    // 头 + 双角
    statue.fillCircle(sx, sy - 4, 20);
    statue.fillTriangle(sx - 14, sy - 16, sx - 36, sy - 44, sx - 2, sy - 22);
    statue.fillTriangle(sx + 14, sy - 16, sx + 36, sy - 44, sx + 2, sy - 22);
    this.addRoomObject(statue, DEPTH.pickup - 2);

    [-1, 1].forEach((side) => {
      const fire = this.add.image(ROOM.cx + side * 152, ROOM.top + 48, "firePlace");
      this.fitDisplaySize(fire, 46);
      fire.setTint(0xffb36b);
      this.addRoomObject(fire, DEPTH.pickup - 1);
      // 火光闪烁
      this.tweens.add({ targets: fire, alpha: 0.68, duration: 220 + this.rng.between(0, 140), yoyo: true, repeat: -1 });
    });

    room.devilStock.forEach((deal, index) => {
      if (deal.taken) return;
      this.seenItems.add(deal.name); // 目击登记
      const x = ROOM.cx + (index === 0 ? -140 : 140);
      const stand = this.add.graphics();
      stand.fillStyle(0x0d0508, 0.4);
      stand.fillEllipse(x, ROOM.cy + 30, 100, 24);
      stand.fillStyle(0x3a232c, 1);
      stand.fillRoundedRect(x - 36, ROOM.cy, 72, 40, 8);
      stand.lineStyle(3, 0xd84a55, 0.85);
      stand.strokeRoundedRect(x - 36, ROOM.cy, 72, 40, 8);
      this.addRoomObject(stand, DEPTH.pickup - 1);

      const orb = this.add.image(x, ROOM.cy - 16, deal.iconFrame);
      this.fitDisplaySize(orb, 46);
      this.addRoomObject(orb, DEPTH.pickup);

      const pickup = this.physics.add.sprite(x, ROOM.cy - 16, deal.iconFrame);
      this.fitDisplaySize(pickup, 46);
      pickup.setAlpha(0.01);
      pickup.kind = "devilItem";
      pickup.deal = deal;
      pickup.setDepth(DEPTH.pickup);
      this.pickups.add(pickup);
      const grab = Math.min(pickup.width, pickup.height) * 0.4;
      pickup.body.setCircle(grab, (pickup.width - grab * 2) / 2, (pickup.height - grab * 2) / 2);

      // 常驻标签只显示代价（心之容器数）；名称/效果靠近时看左上角感应卡
      const label = this.add
        .text(x, ROOM.cy + 48, `${deal.cost} 心容器`, {
          fontFamily: "Arial, sans-serif",
          fontSize: "17px",
          fontStyle: "bold",
          color: "#ff9aa4",
          stroke: "#1a0a0c",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 0);
      this.addRoomObject(label, DEPTH.ui - 1);
    });

    const exit = this.physics.add.sprite(ROOM.cx, ROOM.bottom - 44, "floorExit");
    exit.kind = "devilExit";
    exit.armed = false; // 防误触：玩家须先离开过触发区一次（见 updateExitArming）
    exit.setDisplaySize(64, 48);
    exit.setDepth(DEPTH.pickup - 2);
    this.pickups.add(exit);
    exit.body.setCircle(24, 14, 5);

    const exitLabel = this.add
      .text(ROOM.cx, ROOM.bottom - 10, "返回", {
        fontFamily: "Arial, sans-serif",
        fontSize: "16px",
        color: "#f4efe4",
      })
      .setOrigin(0.5);
    this.addRoomObject(exitLabel, DEPTH.ui - 1);
  }

  // 进恶魔房：踩进 Boss 房的红色恶魔门时触发（门方向记录在 Boss 房 devilDoor，本层内持久）；
  // 恶魔房挂在离屏 (9,9)，离开后回到原房间对应门内侧（leaveDevilRoom）
  enterDevilRoom() {
    SFX.play("devil");
    let room = this.rooms.get("9,9");
    if (!room) {
      room = {
        x: 9,
        y: 9,
        type: "devil",
        cleared: true,
        visited: false,
        itemTaken: false,
        unlocked: true,
        revealed: true,
        looted: false,
        devilStock: null,
      };
      this.rooms.set("9,9", room);
    }
    room.returnTo = { x: this.current.x, y: this.current.y };
    this.current = { x: 9, y: 9 };
    // 落点向内偏：底部门洞内侧约 90px，避免压在返回门上被秒弹回
    this.player.setPosition(ROOM.cx, ROOM.bottom - 44 - 90);
    this.lastMoveAt = this.time.now;
    this.cameras.main.flash(170, 90, 20, 40);
    this.drawRoom();
    this.showToast("恶魔在低语：用生命上限交换力量");
  }

  leaveDevilRoom() {
    const room = this.getRoom();
    const back = room.returnTo || { x: 0, y: 0 };
    this.rooms.delete("9,9");
    this.current = { x: back.x, y: back.y };
    // 回到 Boss 房的恶魔门内侧（幽灵门也按方向落位），兜底落房间中心以南
    const bossRoom = this.getRoom();
    const spots = {
      north: [ROOM.cx, ROOM.top + 46],
      south: [ROOM.cx, ROOM.bottom - 46],
      west: [ROOM.left + 46, ROOM.cy],
      east: [ROOM.right - 46, ROOM.cy],
    };
    const spot = spots[bossRoom && bossRoom.devilDoor] || [ROOM.cx, ROOM.cy + 40];
    this.player.setPosition(spot[0], spot[1]);
    this.lastMoveAt = this.time.now;
    this.cameras.main.flash(170, 40, 30, 26);
    SFX.play("door");
    this.drawRoom();
  }

  spawnRoomObstacles(room, roomRng) {
    // 战斗房：每一占格独立从手工模板库抽一张 13×7 布局 stamp（模板保证门口/中心留空、四向可通行；
    // 各格四边中点必留空，大房跨缝在格中点恒可通行）；格基 offset 化格心公式。
    // 站位标记（G/H/Y/C/B/U/N/J/W）记入 room.markedSpawns，由 seedEnemies 优先落位
    if (room.type === "combat") {
      // ?tpl=模板名/序号：调试参数，强制每格使用指定模板（截图验证用）
      const tplParam = new URLSearchParams(location.search).get("tpl");
      const forced = tplParam
        ? ROOM_TEMPLATES.find((tpl, index) => tpl.name === tplParam || String(index) === tplParam)
        : null;
      const cells = this.roomCells(room);
      room.markedSpawns = [];
      cells.forEach((cell) => {
        const tpl = forced || this.pickLayoutTemplate(roomRng);
        if (!room.layout) room.layout = tpl.name;
        const ox = (cell.x - room.x) * CELL_W;
        const oy = (cell.y - room.y) * CELL_H;
        room.markedSpawns.push(...this.placeLayoutTemplate(tpl, roomRng, ox, oy));
      });
      return;
    }
    // 起始房/特殊房（宝箱/商店/Boss/隐藏/恶魔）保持原有零散摆放；隐藏类只留 0-2 个零散障碍（原版隐藏房近乎空场）
    const count =
      room.type === "start" ? 4
        : room.type === "treasure" ? 3
          : room.type === "shop" ? 0
            : SECRET_TYPES.has(room.type) ? roomRng.between(0, 2)
              : room.type === "boss" ? 6
                : room.type === "devil" ? 2
                  : roomRng.between(5, 8);
    const layouts = [
      [
        { x: ROOM.cx - 150, y: ROOM.cy - 80, kind: "pillar" },
        { x: ROOM.cx + 150, y: ROOM.cy + 80, kind: "pillar" },
        { x: ROOM.cx - 150, y: ROOM.cy + 80, kind: "rock" },
        { x: ROOM.cx + 150, y: ROOM.cy - 80, kind: "rock" },
      ],
      [
        { x: ROOM.cx - 190, y: ROOM.cy, kind: "spikes" },
        { x: ROOM.cx + 190, y: ROOM.cy, kind: "spikes" },
        { x: ROOM.cx, y: ROOM.cy - 112, kind: "pot" },
        { x: ROOM.cx, y: ROOM.cy + 112, kind: "pot" },
      ],
      [
        { x: ROOM.cx - 230, y: ROOM.cy - 106, kind: "rock" },
        { x: ROOM.cx + 230, y: ROOM.cy - 106, kind: "rock" },
        { x: ROOM.cx - 230, y: ROOM.cy + 106, kind: "pot" },
        { x: ROOM.cx + 230, y: ROOM.cy + 106, kind: "pot" },
      ],
    ];

    const planned = roomRng.pick(layouts).slice(0, Math.min(4, count));
    planned.forEach((spot) => this.placeObstacle(spot.kind, spot.x, spot.y, roomRng));

    let attempts = 0;
    const weights = this.floorTheme().weights;
    while (this.obstacleZones.length < count && attempts < 80) {
      attempts += 1;
      const kind = roomRng.pick(weights);
      const x = roomRng.between(ROOM.left + 70, ROOM.right - 70);
      const y = roomRng.between(ROOM.top + 64, ROOM.bottom - 64);
      this.placeObstacle(kind, x, y, roomRng);
    }
  }

  // 模板选取：模板得分 = 各障碍格按 FLOOR_THEMES 权重加总（地窖偏岩石/便便，
  // 洞穴偏岩石，深处尖刺 ×3），沟壑/TNT/站位标记计中性权重 1，再按得分加权随机；
  // roomRng 按房间种子驱动，重进同房布局一致
  pickLayoutTemplate(roomRng) {
    const theme = this.floorTheme();
    const weightOf = (ch) => {
      const kind = TEMPLATE_KINDS[ch];
      if (kind === "pit" || kind === "tnt" || kind === "candle" || TEMPLATE_ENEMY_MARKS.has(ch)) return 1;
      return theme.weights.filter((entry) => entry === kind).length;
    };
    const scored = ROOM_TEMPLATES.map((tpl) => {
      let score = 0;
      tpl.rows.forEach((row) => {
        for (const ch of row) if (ch !== ".") score += weightOf(ch);
      });
      return { tpl, score: Math.max(1, score) };
    });
    let total = 0;
    scored.forEach((entry) => {
      total += entry.score;
    });
    let roll = roomRng.frac() * total;
    for (const entry of scored) {
      roll -= entry.score;
      if (roll <= 0) return entry.tpl;
    }
    return scored[scored.length - 1].tpl;
  }

  // 模板落位：13×7 网格铺满一个单元格（大房逐格调用，ox/oy 为格基世界像素偏移），
  // free 模式放置（模板本身已保证通道/中心留空）；
  // 返回敌人站位标记列表 [{type,x,y}]（G/H/Y/C/B/U/N/J/W 格不放障碍，只供 seedEnemies 用）
  placeLayoutTemplate(tpl, roomRng, ox = 0, oy = 0) {
    const marks = [];
    tpl.rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c += 1) {
        const ch = row[c];
        if (ch === ".") continue;
        const { x, y } = this.stampCellCenter(ox, oy, r, c);
        if (TEMPLATE_ENEMY_MARKS.has(ch)) {
          marks.push({ type: TEMPLATE_KINDS[ch], x, y });
          continue;
        }
        const obstacle = this.placeObstacle(TEMPLATE_KINDS[ch], x, y, roomRng, true);
        // 沟壑：随机帧（placeObstacle 内）+ 随机翻转变换朝向（不再旋转，旋转会把坑沿亮边翻到怪角度）
        if (obstacle && obstacle.kind === "pit") {
          obstacle.setFlipX(roomRng.frac() < 0.5);
          obstacle.setFlipY(roomRng.frac() < 0.5);
        }
      }
    });
    return marks;
  }

  placeObstacle(kind, x, y, roomRng, free = false) {
    const type = OBSTACLE_TYPES[kind];
    const scale = roomRng.realInRange(type.scaleMin, type.scaleMax);
    const radius = type.radius * scale;
    if (!free && !this.canPlaceObstacle(x, y, radius)) return false;

    // 染色岩（原版概率玩法）：独立官方贴图；炸毁按原版表掉落（destroyObstacle）
    const tinted = kind === "rock" && roomRng.frac() < 0.04;
    // 岩石帧按楼层主题取子集（地窖棕 / 洞穴灰蓝 / 深处暗红），与本层皮肤配套
    const rockFrames = kind === "rock" ? this.floorTheme().rockFrames : null;
    const frame =
      type.frames && !tinted ? (rockFrames ? roomRng.pick(rockFrames) : roomRng.between(0, type.frames - 1)) : null;
    // 沟壑贴图按楼层选用官方风变体液（地窖/洞穴/深处各 4 帧，离线生成）；柱子同按层选染色变体
    const texture = kind === "pit"
      ? ["pitBasement", "pitCaves", "pitDepths"][Math.min(this.floor, 3) - 1]
      : kind === "pillar"
        ? ["pillarBasement", "pillarCaves", "pillarDepths"][Math.min(this.floor, 3) - 1]
        : tinted
          ? "tintedRockTile"
          : type.texture;
    const obstacle = this.obstacles.create(x, y, texture, frame);
    obstacle.kind = kind;
    obstacle.tinted = tinted;
    // 便便 HP3 打三段退化（tearHitObstacles）；壁炉 HP2；TNT HP1 受击即爆；岩/柱/尖刺/沟壑不可打
    obstacle.hp = kind === "pot" ? 3 : kind === "candle" ? 2 : kind === "tnt" ? 1 : 0;
    obstacle.bombProof = kind === "pillar" || kind === "spikes" || kind === "pit";
    const size = type.size * scale;
    obstacle.potBase = kind === "pot" ? size : 0; // 便便退化缩放基准
    this.fitDisplaySize(obstacle, size);
    obstacle.setDepth(DEPTH.pickup - 3);
    obstacle.refreshBody();
    const dw = obstacle.displayWidth;
    const dh = obstacle.displayHeight;
    // 判定圈按 52px 格近满格设定（notes §1.2：岩石/罐/便便碰撞体矩形近满格；
    // 沟壑收紧到 0.40：视觉上踩到坑沿碎环才算掉进判定，不会"隔空阻挡"）
    const bodyRadius = Math.min(dw, dh) * (kind === "spikes" ? 0.38 : kind === "pit" ? 0.4 : 0.44);
    obstacle.body.setCircle(bodyRadius, dw / 2 - bodyRadius, dh / 2 - bodyRadius);
    obstacle.blockRadius = bodyRadius;

    this.obstacleZones.push({ x, y, radius: radius + 14 });
    this.roomObjects.push(obstacle);
    return obstacle;
  }

  canPlaceObstacle(x, y, radius) {
    if (Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) < radius + 72) return false;
    // 保留区（52px 格为基准）：各门槽行进线 1.5 格 + 中心 3×3 格 + 玩家出生带；
    // 大房按外缘槽位逐条计（内部格间界不设保留带，跨缝照常可摆）
    const room = this.getRoom();
    const rect = (this.curRoom === room && this.curRect) || this.roomRect(room);
    const slots = (this.curRoom === room && this.curSlots) || this.doorSlots(room);
    const laneW = (CELL_W / TEMPLATE_COLS) * 1.5;
    const laneH = (CELL_H / TEMPLATE_ROWS) * 1.5;
    const reserved = slots.map((slot) => {
      if (slot.label === "north") return new Phaser.Geom.Rectangle(slot.cx - laneW, rect.top - 30, laneW * 2, laneH + 30);
      if (slot.label === "south") return new Phaser.Geom.Rectangle(slot.cx - laneW, rect.bottom - laneH, laneW * 2, laneH + 30);
      if (slot.label === "west") return new Phaser.Geom.Rectangle(rect.left - 30, slot.cy - laneH, laneW + 30, laneH * 2);
      return new Phaser.Geom.Rectangle(rect.right - laneW, slot.cy - laneH, laneW + 30, laneH * 2);
    });
    reserved.push(new Phaser.Geom.Rectangle(rect.cx - laneW, rect.cy - laneH, laneW * 2, laneH * 2));
    const probe = new Phaser.Geom.Rectangle(x - radius, y - radius, radius * 2, radius * 2);
    if (reserved.some((zone) => Phaser.Geom.Intersects.RectangleToRectangle(probe, zone))) return false;
    return !this.obstacleZones.some((zone) => Phaser.Math.Distance.Between(x, y, zone.x, zone.y) < radius + zone.radius);
  }

  // 官方渲染图地板贴花风化版：稀疏小石子簇（不规则多边形，三色就地层采样）
  // + 少量裂纹短线；密度对标 Stage_Basement_room 的地板贴花（每单元 10 簇）
  scatterRubble(room, roomRng) {
    const rect = this.roomRect(room);
    const cells = this.roomCells(room).length;
    const amount = (room.type === "treasure" ? 6 : 10) * cells; // 大房面积按格翻倍，碎屑密度一致
    const chips = room.type === "treasure" ? [0x4c6f66, 0x3a5750, 0x5c7f74] : this.floorTheme().chips;
    for (let i = 0; i < amount; i += 1) {
      const x = roomRng.between(rect.left + 42, rect.right - 42);
      const y = roomRng.between(rect.top + 40, rect.bottom - 40);
      if (this.obstacleZones.some((zone) => Phaser.Math.Distance.Between(x, y, zone.x, zone.y) < zone.radius + 22)) continue;
      const chip = this.add.graphics();
      // 一小簇 2-4 粒不规则石子（3-5 边形，压扁 0.7 俯视感）
      const stones = roomRng.between(2, 4);
      for (let s = 0; s < stones; s += 1) {
        const sx = x + roomRng.between(-9, 9);
        const sy = y + roomRng.between(-5, 5);
        const r = roomRng.between(2, 4.5);
        chip.fillStyle(roomRng.pick(chips), roomRng.realInRange(0.42, 0.62));
        const n = roomRng.between(3, 5);
        const pts = [];
        for (let k = 0; k < n; k += 1) {
          const a = (Math.PI * 2 * k) / n + roomRng.realInRange(-0.5, 0.5);
          const rr = r * roomRng.realInRange(0.55, 1.2);
          pts.push({ x: sx + Math.cos(a) * rr, y: sy + Math.sin(a) * rr * 0.7 });
        }
        chip.fillPoints(pts, true);
      }
      // 裂纹短线：2-3 段折线，稀疏出现才像贴花而非涂鸦
      if (roomRng.frac() < 0.4) {
        chip.lineStyle(1, chips[1], 0.5);
        let cx = x + roomRng.between(-10, 10);
        let cy = y + roomRng.between(-6, 6);
        chip.beginPath();
        chip.moveTo(cx, cy);
        const segs = roomRng.between(2, 3);
        for (let s = 0; s < segs; s += 1) {
          cx += roomRng.between(-8, 8);
          cy += roomRng.between(-4, 4);
          chip.lineTo(cx, cy);
        }
        chip.strokePath();
      }
      this.addRoomObject(chip, DEPTH.pickup - 4);
    }
  }

  buildHud() {
    // 原版左上布局：主动道具 46px 方格居左上角，心形排其右（宽一颗心距），
    // 金币/钥匙/炸弹三行"图标+×N"列于方格下方（ref frames BV1c2Tu6EEtv 对照）
    const hudCounterStyle = {
      fontFamily: "Arial, sans-serif",
      fontSize: "15px",
      fontStyle: "bold",
      color: "#f4efe4",
      stroke: "#0d0a08",
      strokeThickness: 3,
    };
    this.hud = {
      hearts: [],
      // 金币/钥匙/炸弹三行计数：icon 缩放 ~20px，updateHud 只改 ×N 文本
      counts: ["coin", "key", "bomb"].map((kind, i) => {
        const icon = this.add.image(36, 66 + i * 22, SPRITES[kind]);
        this.fitDisplaySize(icon, 20);
        const text = this.add.text(52, 66 + i * 22, "×0", hudCounterStyle).setOrigin(0, 0.5);
        return { kind, icon, text };
      }),
      // 主动道具方格：底框由下方 graphics 一次画好，此处只管贴图与充能数
      activeSlot: this.add.graphics(),
      activeIcon: this.add.image(41, 29, "itemTheHalo").setVisible(false),
      activeCharge: this.add
        .text(62, 49, "", {
          fontFamily: "Arial, sans-serif",
          fontSize: "12px",
          fontStyle: "bold",
          color: "#f4efe4",
          stroke: "#0d0a08",
          strokeThickness: 3,
        })
        .setOrigin(1, 1)
        .setVisible(false),
      // 楼层+房名：顶部中央 Time 左侧（种子与属性面板挪入暂停页，屏幕不常驻）
      floorText: this.add
        .text(WIDTH / 2 - 84, 10, "", {
          fontFamily: "Arial, sans-serif",
          fontSize: "14px",
          fontStyle: "bold",
          color: "#d8ccb8",
          stroke: "#0d0a08",
          strokeThickness: 3,
        })
        .setOrigin(1, 0),
      toast: this.add.text(WIDTH / 2, HEIGHT - 42, "", {
        fontFamily: "Arial, sans-serif",
        fontSize: "18px",
        color: "#f7ebcf",
        backgroundColor: "rgba(12,10,9,0.62)",
        padding: { x: 14, y: 8 },
      }).setOrigin(0.5),
      minimap: this.add.graphics(),
      // 顶部中央游戏计时（mm:ss，暂停时不走）
      timer: this.add
        .text(WIDTH / 2, 8, "Time: 00:00", {
          fontFamily: "Arial, sans-serif",
          fontSize: "17px",
          fontStyle: "bold",
          color: "#f4efe4",
          stroke: "#0d0a08",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 0),
      // 右下角持有物（药丸/卡牌）：图标 + 名字，未鉴定药丸显示 ???
      heldIcon: this.add.image(WIDTH - 24, HEIGHT - 26, "pill").setVisible(false),
      heldText: this.add
        .text(WIDTH - 46, HEIGHT - 26, "", {
          fontFamily: "Arial, sans-serif",
          fontSize: "16px",
          fontStyle: "bold",
          color: "#f4efe4",
          stroke: "#0d0a08",
          strokeThickness: 3,
        })
        .setOrigin(1, 0.5),
    };
    // 主动道具 46px 方格底：深底圆角 + 描边（一次性绘制，之后不再改）
    this.hud.activeSlot.fillStyle(0x120e0b, 0.82);
    this.hud.activeSlot.fillRoundedRect(18, 6, 46, 46, 8);
    this.hud.activeSlot.lineStyle(2, 0x8a6a45, 0.9);
    this.hud.activeSlot.strokeRoundedRect(19, 7, 44, 44, 7);
    this.hud.counts.forEach(({ icon, text }) => {
      icon.setDepth(DEPTH.ui);
      text.setDepth(DEPTH.ui);
    });
    this.hud.activeSlot.setDepth(DEPTH.ui);
    this.hud.activeIcon.setDepth(DEPTH.ui + 1);
    this.hud.activeCharge.setDepth(DEPTH.ui + 1);
    this.hud.floorText.setDepth(DEPTH.ui);
    this.hud.toast.setDepth(DEPTH.ui);
    this.hud.minimap.setDepth(DEPTH.ui);
    this.hud.timer.setDepth(DEPTH.ui);
    this.hud.heldIcon.setDepth(DEPTH.ui);
    this.hud.heldText.setDepth(DEPTH.ui);
    // 镜头滚动（多尺寸房）下 HUD 全部钉屏：漏一个元素它就会随世界漂移
    const pinHud = (obj) => obj.setScrollFactor(0);
    this.hud.counts.forEach(({ icon, text }) => {
      pinHud(icon);
      pinHud(text);
    });
    ["activeSlot", "activeIcon", "activeCharge", "floorText", "toast", "minimap", "timer", "heldIcon", "heldText"].forEach((key) =>
      pinHud(this.hud[key]),
    );

    // Tab 全屏地图（默认隐藏，切换时 drawBigmap 重绘）
    this.bigmap = {
      bg: this.add.graphics().setDepth(DEPTH.overlay - 10).setVisible(false).setScrollFactor(0),
      g: this.add.graphics().setDepth(DEPTH.overlay - 9).setVisible(false).setScrollFactor(0),
      title: this.add
        .text(WIDTH / 2, 0, "楼层地图（Tab 关闭）", {
          fontFamily: "Arial, sans-serif",
          fontSize: "20px",
          fontStyle: "bold",
          color: "#f4efe4",
        })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.overlay - 9)
        .setVisible(false)
        .setScrollFactor(0),
    };

    // 暂停遮罩（Esc/P 切换）；label 上移到中心偏上，下方 details 常驻种子号与六项属性
    this.pauseVeil = {
      bg: this.add.graphics().setDepth(DEPTH.overlay).setVisible(false).setScrollFactor(0),
      label: this.add
        .text(WIDTH / 2, HEIGHT / 2 - 82, "已暂停\nEsc / P 继续", {
          fontFamily: "Arial, sans-serif",
          fontSize: "34px",
          fontStyle: "bold",
          color: "#f4efe4",
          align: "center",
          lineSpacing: 10,
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay + 1)
        .setVisible(false)
        .setScrollFactor(0),
      // 种子号 + 属性面板（原屏幕常驻文字移入此处，togglePause 时刷新）
      details: this.add
        .text(WIDTH / 2, HEIGHT / 2 + 20, "", {
          fontFamily: "Arial, sans-serif",
          fontSize: "16px",
          color: "#d8ccb8",
          align: "center",
          lineSpacing: 6,
        })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.overlay + 1)
        .setVisible(false)
        .setScrollFactor(0),
    };
    this.pauseVeil.bg.fillStyle(0x060505, 0.62);
    this.pauseVeil.bg.fillRect(0, 0, WIDTH, HEIGHT);

    // 道具感应卡：靠近底座/商店商品/恶魔交易约 90px 时显示（updateItemCard 驱动），
    // 位于左上计数行右侧的空置墙带
    const cardBg = this.add.graphics();
    const cardIcon = this.add.image(26, 25, "itemTheHalo");
    const cardName = this.add
      .text(50, 7, "", {
        fontFamily: "Arial, sans-serif",
        fontSize: "15px",
        fontStyle: "bold",
        color: "#f4efe4",
        stroke: "#0d0a08",
        strokeThickness: 3,
      })
      .setOrigin(0, 0);
    const cardDesc = this.add
      .text(50, 27, "", {
        fontFamily: "Arial, sans-serif",
        fontSize: "13px",
        color: "#d8ccb8",
        stroke: "#0d0a08",
        strokeThickness: 3,
      })
      .setOrigin(0, 0);
    const cardBox = this.add.container(ROOM.left + 8, 92, [cardBg, cardIcon, cardName, cardDesc]);
    cardBox.setDepth(DEPTH.ui + 1).setVisible(false).setScrollFactor(0); // 感应卡钉屏（屏幕空间坐标）
    this.itemCard = { box: cardBox, bg: cardBg, icon: cardIcon, name: cardName, desc: cardDesc };
  }

  // 道具感应卡：扫描 90px 感应半径内的道具类拾取物（底座/掉落道具/商店商品/恶魔交易），
  // 最近的一个显示图标+名称+效果（商品/交易附带价格），离开半径即隐藏
  updateItemCard() {
    const card = this.itemCard;
    if (!card) return;
    let best = null;
    let bestDist = 90;
    this.pickups.children.each((pickup) => {
      if (!pickup.active) return;
      let info = null;
      if ((pickup.kind === "item" || pickup.kind === "droppedItem") && pickup.item) {
        const item = pickup.item;
        info = { icon: item.iconFrame, name: item.name, desc: item.type === "active" ? `主动 · ${item.desc}` : item.desc };
      } else if (pickup.kind === "shopItem" && pickup.slot) {
        const slot = pickup.slot;
        if (slot.kind === "item") {
          const item = slot.item;
          info = {
            icon: item.iconFrame,
            name: item.name,
            desc: `${item.type === "active" ? "主动 · " : ""}${item.desc} ｜ ${slot.sale ? "SALE " : ""}${slot.price} 金币`,
          };
        } else {
          info = {
            icon: this.pickupTexture(slot.kind),
            name: slot.name,
            desc: `${slot.sale ? "SALE " : ""}${slot.price} 金币`,
          };
        }
      } else if (pickup.kind === "devilItem" && pickup.deal) {
        const deal = pickup.deal;
        info = { icon: deal.iconFrame, name: deal.name, desc: `${deal.desc} ｜ 代价 ${deal.cost} 心容器` };
      }
      if (!info) return;
      const distance = Phaser.Math.Distance.Between(pickup.x, pickup.y, this.player.x, this.player.y);
      if (distance < bestDist) {
        bestDist = distance;
        best = info;
      }
    });
    if (!best) {
      card.box.setVisible(false);
      return;
    }
    card.icon.setTexture(best.icon);
    this.fitDisplaySize(card.icon, 34);
    card.name.setText(best.name);
    card.desc.setText(best.desc);
    const width = Math.max(180, 56 + Math.max(card.name.width, card.desc.width) + 12);
    card.bg.clear();
    card.bg.fillStyle(0x120e0b, 0.88);
    card.bg.fillRoundedRect(0, 0, width, 50, 8);
    card.bg.lineStyle(2, 0x8a6a45, 0.9);
    card.bg.strokeRoundedRect(1, 1, width - 2, 48, 7);
    card.box.setVisible(true);
  }

  // 心形 sprite 池：按需创建，之后只改可见性/裁切/tint，避免每次 updateHud 全量重建
  ensureHeartPool(size) {
    while (this.hud.hearts.length < size) {
      const heart = this.add.image(0, 24, SPRITES.heart).setDisplaySize(21, 17).setVisible(false).setScrollFactor(0);
      heart.setDepth(DEPTH.ui);
      this.hud.hearts.push(heart);
    }
  }

  updateHud() {
    const stats = this.playerStats;
    // 心形排主动道具方格右侧（原版布局：方格居左上角，心从其右缘起排）
    const heartX = 80;
    // 红心容器：每颗有 整心/半心/空心 三态（半心用贴图左半裁切）；魂心排红心后面
    const containers = Math.ceil(stats.maxHp / 2);
    const soulHearts = Math.ceil(stats.soulHp / 2);
    this.ensureHeartPool(containers + soulHearts);
    let slot = 0;
    for (let i = 0; i < containers; i += 1) {
      const heart = this.hud.hearts[slot];
      slot += 1;
      const fill = Phaser.Math.Clamp(stats.hp - i * 2, 0, 2); // 2 整心 / 1 半心 / 0 空心
      heart.clearTint();
      heart.setPosition(heartX + i * 26, 24);
      heart.setVisible(true);
      heart.setAlpha(fill === 0 ? 0.2 : 1);
      if (fill === 1) heart.setCrop(0, 0, heart.frame.width / 2, heart.frame.height);
      else heart.setCrop();
    }
    for (let i = 0; i < soulHearts; i += 1) {
      const soul = this.hud.hearts[slot];
      slot += 1;
      const fill = Phaser.Math.Clamp(stats.soulHp - i * 2, 0, 2);
      soul.setTint(0x6db7ff);
      soul.setPosition(heartX + (containers + i) * 26, 24);
      soul.setVisible(true);
      soul.setAlpha(1);
      if (fill === 1) soul.setCrop(0, 0, soul.frame.width / 2, soul.frame.height);
      else soul.setCrop();
    }
    for (let i = slot; i < this.hud.hearts.length; i += 1) {
      this.hud.hearts[i].setVisible(false);
    }

    const room = this.getRoom();
    // 金币/钥匙/炸弹三行"图标+×N"
    const counterValues = { coin: stats.coins, key: stats.keys, bomb: stats.bombs };
    this.hud.counts.forEach(({ kind, text }) => text.setText(`×${counterValues[kind]}`));
    // 主动道具方格：有道具显示 iconFrame + 右下角充能 n/m；无道具只留空方格
    if (stats.activeItem) {
      this.hud.activeIcon.setTexture(stats.activeItem.iconFrame);
      this.fitDisplaySize(this.hud.activeIcon, 32);
      this.hud.activeIcon.setVisible(true);
      this.hud.activeCharge.setText(`${stats.activeCharge}/${stats.activeChargeMax}`).setVisible(true);
    } else {
      this.hud.activeIcon.setVisible(false);
      this.hud.activeCharge.setVisible(false);
    }
    // 楼层+房名：顶部中央 Time 左侧（种子号在暂停页）
    this.hud.floorText.setText(`第 ${this.floor}/${MAX_FLOOR} 层 · ${this.roomName(room)}`);
    // 右下角持有物：药丸未鉴定显示 ???，鉴定后显示效果名；卡牌显示卡名
    const held = stats.heldItem;
    if (held) {
      let name;
      if (held.kind === "pill") {
        this.hud.heldIcon.setTexture("pill");
        this.hud.heldIcon.setTint(PILL_TINTS[held.pillId]);
        name = this.identifiedPills.has(held.pillId) ? this.pillDeck[held.pillId].name : "???";
      } else {
        const card = CARD_POOL.find((c) => c.id === held.cardId);
        this.hud.heldIcon.setTexture("card");
        this.hud.heldIcon.setTint(card ? card.tint : 0xffffff);
        name = card ? card.name : "?";
      }
      this.fitDisplaySize(this.hud.heldIcon, 26);
      this.hud.heldIcon.setVisible(true);
      this.hud.heldText.setText(name).setVisible(true);
    } else {
      this.hud.heldIcon.setVisible(false);
      this.hud.heldText.setVisible(false);
    }
    this.drawMinimap();
  }

  roomName(room) {
    if (room.type === "start") return "起始房";
    if (room.type === "treasure") return "道具房";
    if (room.type === "shop") return "商店";
    if (room.type === "hidden") return "隐藏房";
    if (room.type === "superSecret") return "超级隐藏房";
    if (room.type === "devil") return "恶魔房";
    if (room.type === "boss") return "Boss 房";
    return room.cleared ? "已清理房间" : "战斗房";
  }

  drawMinimap() {
    this.paintMap(this.hud.minimap, 15, 4, WIDTH - 132, 24);
    if (this.bigmapVisible) this.drawBigmap(); // 全屏地图开着时同步刷新
  }

  // 官方 9×8 房型小图 → 像素复制 ×3 crisp 纹理（本项目 pixelArt:false，9px 原图直接放大会糊；
  // 小地图按 ~15px 贴、Tab 大图按 ~36px 贴，均保持可辨认）
  makeMapIconTextures() {
    Object.values(MAP_ICONS).forEach((srcKey) => {
      const key = `${srcKey}Crisp`;
      if (this.textures.exists(key)) return;
      const src = this.textures.get(srcKey).getSourceImage();
      const canvas = document.createElement("canvas");
      canvas.width = src.width * 3;
      canvas.height = src.height * 3;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      this.textures.addCanvas(key, canvas);
    });
    // 图章池：小地图/Tab 大图各一套 image（scrollFactor 0 钉屏），按绘制轮次复用
    this.mapIconStamps = { mini: [], big: [] };
  }

  // 房型图标图章：从池里取一只未用的 image 摆到瓦片中央；paintMap 每轮先把整池标记未用，
  // 画完把仍闲置的藏掉（图标贴图是官方资源，房型变化时 setTexture 即复用）
  stampMapIcon(poolName, type, cx, cy, tile, alpha = 1) {
    const srcKey = MAP_ICONS[type];
    if (!srcKey || !this.mapIconStamps) return;
    const pool = this.mapIconStamps[poolName];
    let img = pool.find((entry) => !entry.used);
    if (!img) {
      img = this.add.image(0, 0, `${srcKey}Crisp`).setScrollFactor(0);
      pool.push(img);
      img.setDepth(poolName === "big" ? DEPTH.overlay - 8 : DEPTH.ui + 1);
    }
    img.used = true;
    img.setTexture(`${srcKey}Crisp`);
    img.setPosition(cx, cy);
    // crisp 纹理已是源图 3 倍像素复制：小图瓦片按 tile 显示、大图瓦片也就 tile 显示
    const size = Math.max(10, Math.min(tile - 2, 40));
    img.setDisplaySize(size, size);
    img.setAlpha(alpha);
    img.setVisible(poolName === "mini" || this.bigmapVisible);
  }

  // 小地图/全屏地图共用绘制：进过的房按房型着色、当前房高亮、未进相邻房一律灰块；
  // 多尺寸大房的多个格子合并成一个矩形块上色（当前房白描边跨格），缩放居中逻辑不变；
  // 特殊房在瓦片中央贴官方房型小图（图章池 image），
  // 未揭示的隐藏房/超级隐藏房只有世界卡（mapReveal）时才显示幽灵块
  paintMap(g, tile, gap, ox, oy, poolName = "mini") {
    g.clear();
    if (this.mapIconStamps) this.mapIconStamps[poolName].forEach((img) => { img.used = false; });
    const cur = this.getRoom();
    [...new Set(this.rooms.values())].forEach((room) => {
      if (Math.abs(room.x) > 3 || Math.abs(room.y) > 3) return;
      const entered = this.enteredRooms.has(`${room.x},${room.y}`);
      const seen = this.playerStats.mapReveal || entered || this.nearCurrent(room);
      // 大房块：占格外接矩形跨格铺满（格间不留缝）
      const cells = this.roomCells(room);
      const minX = Math.min(...cells.map((c) => c.x));
      const minY = Math.min(...cells.map((c) => c.y));
      const maxX = Math.max(...cells.map((c) => c.x));
      const maxY = Math.max(...cells.map((c) => c.y));
      const x = ox + (minX + 3) * (tile + gap);
      const y = oy + (minY + 3) * (tile + gap);
      const bw = (maxX - minX + 1) * (tile + gap) - gap;
      const bh = (maxY - minY + 1) * (tile + gap) - gap;
      if (SECRET_TYPES.has(room.type) && !room.revealed) {
        if (!this.playerStats.mapReveal) return;
        g.fillStyle(room.type === "superSecret" ? 0x55486e : 0x6a5a7a, 0.45);
        g.fillRoundedRect(x, y, bw, bh, 3);
        this.stampMapIcon(poolName, room.type, x + bw / 2, y + bh / 2, tile, 0.8);
        return;
      }
      if (!seen) return;
      // 未进入的相邻房间一律灰块，只有进过的（或全图揭示）才显示房型颜色
      if (!entered && !this.playerStats.mapReveal) {
        g.fillStyle(0x565049, 0.42);
        g.fillRoundedRect(x, y, bw, bh, 3);
        return;
      }
      let color = 0x6a6258;
      if (room.type === "treasure") color = 0x58a69b;
      if (room.type === "shop") color = 0xd0a85d;
      if (room.type === "hidden") color = 0xb99be0;
      if (room.type === "superSecret") color = 0x8f6cc4;
      if (room.type === "boss") color = 0xa84545;
      if (room.type === "start") color = 0xd0b25b;
      g.fillStyle(color, room === cur ? 1 : 0.58);
      g.fillRoundedRect(x, y, bw, bh, 3);
      if (room === cur) {
        g.lineStyle(2, 0xf8efe1, 1);
        g.strokeRoundedRect(x - 2, y - 2, bw + 4, bh + 4, 4);
      }
      this.stampMapIcon(poolName, room.type, x + bw / 2, y + bh / 2, tile);
    });
    // 本轮没用到的图章隐藏（池复用不销毁，避免 HUD 对象反复增删）
    if (this.mapIconStamps) this.mapIconStamps[poolName].forEach((img) => { if (!img.used) img.setVisible(false); });
  }

  // 房型像素图标：直接画进地图 graphics，尺寸随瓦片缩放（小地图 tile15 / 全图 tile38 同步）
  paintMapIcon(g, type, x, y, tile) {
    const cx = x + tile / 2;
    const cy = y + tile / 2;
    const s = tile / 15; // 以小地图 tile=15 为基准的缩放系数
    const ink = 0xfdf6e8;
    if (type === "treasure") {
      // 道具台：暗金底座 + 亮色道具
      g.fillStyle(0x3a2c14, 1);
      g.fillRect(cx - 3.5 * s, cy + 1.5 * s, 7 * s, 2.5 * s);
      g.fillStyle(ink, 1);
      g.fillRect(cx - 1.5 * s, cy - 3.5 * s, 3 * s, 5 * s);
      g.fillCircle(cx, cy - 4.5 * s, 2.2 * s);
    } else if (type === "shop") {
      // 三根竖币
      g.fillStyle(0x3a2c14, 1);
      g.fillRect(cx - 5.5 * s, cy - 4 * s, 11 * s, 8.5 * s);
      g.fillStyle(ink, 1);
      for (let i = -1; i <= 1; i += 1) {
        g.fillRoundedRect(cx + i * 3.4 * s - 1.1 * s, cy - 3.5 * s, 2.2 * s, 7 * s, 1 * s);
      }
    } else if (type === "boss") {
      // 骷髅：白脸 + 两点眼睛
      g.fillStyle(ink, 1);
      g.fillCircle(cx, cy, 4 * s);
      g.fillRect(cx - 2.5 * s, cy + 2.5 * s, 5 * s, 2 * s);
      g.fillStyle(0x181008, 1);
      g.fillCircle(cx - 1.6 * s, cy - 0.6 * s, 1 * s);
      g.fillCircle(cx + 1.6 * s, cy - 0.6 * s, 1 * s);
    } else if (type === "hidden" || type === "superSecret") {
      // 问号（3×5 像素字）
      const rows = ["111", "001", "011", "000", "010"];
      const cell = Math.max(1, 1.4 * s);
      const px = cx - (3 * cell) / 2;
      const py = cy - (5 * cell) / 2;
      g.fillStyle(ink, 1);
      rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c += 1) {
          if (row[c] === "1") g.fillRect(px + c * cell, py + r * cell, cell, cell);
        }
      });
    }
  }

  // Tab 全屏楼层地图：放大版小地图，规则一致
  drawBigmap() {
    const tile = 38;
    const gap = 6;
    const span = 7 * tile + 6 * gap;
    const ox = (WIDTH - span) / 2;
    const oy = (HEIGHT - span) / 2 + 14;
    const bg = this.bigmap.bg;
    bg.clear();
    bg.fillStyle(0x0b0908, 0.78);
    bg.fillRoundedRect(ox - 28, oy - 56, span + 56, span + 92, 14);
    bg.lineStyle(2, 0xb99b72, 0.9);
    bg.strokeRoundedRect(ox - 28, oy - 56, span + 56, span + 92, 14);
    this.bigmap.title.setPosition(WIDTH / 2, oy - 44);
    this.paintMap(this.bigmap.g, tile, gap, ox, oy, "big");
  }

  toggleBigmap() {
    this.bigmapVisible = !this.bigmapVisible;
    this.bigmap.bg.setVisible(this.bigmapVisible);
    this.bigmap.g.setVisible(this.bigmapVisible);
    this.bigmap.title.setVisible(this.bigmapVisible);
    if (this.bigmapVisible) this.drawBigmap();
    else if (this.mapIconStamps) this.mapIconStamps.big.forEach((img) => img.setVisible(false)); // 收图同步藏图标
  }

  // Esc/P 暂停：物理暂停 + 遮罩，暂停时音乐停、只响应暂停键与 R
  togglePause() {
    if (this.gameEnded) return;
    this.touchTaps = Object.create(null); // 暂停期间不缓存触屏按键，避免恢复后误触发
    this.isPaused = !this.isPaused;
    this.pauseVeil.bg.setVisible(this.isPaused);
    this.pauseVeil.label.setVisible(this.isPaused);
    this.pauseVeil.details.setVisible(this.isPaused);
    if (this.isPaused) {
      // 暂停页收纳原屏幕常驻信息：种子号 + 六项属性（公式同原属性面板）
      const stats = this.playerStats;
      const tearsPerSec = 1000 / stats.fireDelay;
      const range = Math.round((stats.tearSpeed * stats.tearLife) / 1000);
      this.pauseVeil.details.setText(
        `种子 ${this.runSeed}\n` +
          `伤害 ${stats.damage.toFixed(1)}   攻速 ${tearsPerSec.toFixed(1)}/秒   弹速 ${Math.round(stats.tearSpeed)}\n` +
          `射程 ${range}   移速 ${Math.round(stats.speed)}   幸运 ${Math.round(stats.rewardLuck * 100)}%`,
      );
      this.stopPlayerWalk();
      this.physics.pause();
      MUSIC.stop();
    } else {
      this.physics.resume();
      MUSIC.start();
    }
  }

  // M 静音：音效与音乐一起开关
  toggleMute() {
    SFX.muted = !SFX.muted;
    MUSIC.setMuted(SFX.muted);
    this.showToast(SFX.muted ? "已静音（按 M 恢复）" : "声音已恢复");
  }

  // R 重开需 2 秒内连按两次确认，防误触；结算画面直接重开
  tryRestart(time) {
    if (this.gameEnded || time < this.restartArmedAt) {
      this.scene.restart();
      return true;
    }
    this.restartArmedAt = time + 2000;
    this.showToast("再按 R 确认重开");
    return false;
  }

  // 与当前房相邻（大房按全部占格任一相接即邻，含自身）
  nearCurrent(room) {
    const cur = this.getRoom();
    if (!cur) return false;
    if (room === cur) return true;
    const curCells = this.roomCells(cur);
    return this.roomCells(room).some((a) =>
      curCells.some((b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1),
    );
  }

  update(time, delta) {
    if (Phaser.Input.Keyboard.JustDown(this.keys.restart)) {
      if (this.tryRestart(time)) return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.pause) || Phaser.Input.Keyboard.JustDown(this.keys.pauseAlt)) {
      this.togglePause();
    }
    if (this.isPaused || this.gameEnded) return;
    if (Phaser.Input.Keyboard.JustDown(this.keys.mute)) this.toggleMute();
    if (Phaser.Input.Keyboard.JustDown(this.keys.map)) this.toggleBigmap();

    // 顶部中央计时：只在游戏进行中累计，秒变化时才刷新文本
    this.runTimeMs += delta;
    const timerSec = Math.floor(this.runTimeMs / 1000);
    if (timerSec !== this.lastTimerSec) {
      this.lastTimerSec = timerSec;
      const mm = String(Math.floor(timerSec / 60)).padStart(2, "0");
      const ss = String(timerSec % 60).padStart(2, "0");
      this.hud.timer.setText(`Time: ${mm}:${ss}`);
    }

    this.tryUseActiveItem();
    this.tryPlaceBomb();
    this.tryUseHeld();
    this.handleMovement();
    // 巴比伦娼妇：生命垂危（≤ 半颗红心）时伤害/射速增益生效
    this.wobActive = Boolean(this.playerStats.whoreOfBabylon) && this.playerStats.hp <= 1;
    this.handleShooting(time);
    this.keepInRoom(this.player);
    this.tryDoorTransition(time);
    this.updateExitArming();
    this.updateEnemies(time, delta);
    this.updateTears(delta);
    this.updateBombs(time);
    this.updateFamiliars(time);
    this.updateMagnet();
    this.cleanProjectiles();
    this.updateHudEffects(time);
    this.updateItemCard();
  }

  // ---------- 触屏虚拟控件 ----------
  // 触屏设备（或 ?touch=1 桌面调试）显示 DOM 双摇杆 + 主动/药丸/炸弹/暂停按钮。
  // 摇杆把方向直接写进 keys.*.isDown（与 ?ff 快进同一路径，frame 轮询天然兼容）；
  // 一次性按键走 touchTaps 队列，由 tryUseActiveItem/tryUseHeld/tryPlaceBomb 消费。
  setupTouchControls() {
    const controls = document.getElementById("touch-controls");
    if (!controls) return;
    const force = new URLSearchParams(location.search).get("touch");
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    if (!force && !coarse) return;

    controls.hidden = false;
    // scene.restart 会重跑 create，但场景实例不变、DOM 也只绑一次
    if (this.touchBound) return;
    this.touchBound = true;

    // 控件上的首次触摸也要解锁音频（canvas 的 pointerdown 监听收不到 DOM 事件）
    controls.addEventListener(
      "pointerdown",
      () => {
        SFX.ensure();
        MUSIC.start();
      },
      true,
    );
    controls.addEventListener("contextmenu", (ev) => ev.preventDefault());

    this.bindStick(document.getElementById("stick-move"), { up: "up", down: "down", left: "left", right: "right" });
    this.bindStick(document.getElementById("stick-fire"), { up: "cup", down: "cdown", left: "cleft", right: "cright" });
    const bindTap = (id, name) => {
      document.getElementById(id).addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        this.queueTap(name);
      });
    };
    bindTap("tb-active", "action");
    bindTap("tb-held", "held");
    bindTap("tb-bomb", "bomb");
    document.getElementById("tb-pause").addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      this.togglePause();
    });
  }

  // 固定式摇杆：按下后跟踪单一 pointerId 的位移，超过死区即置对应方向键
  bindStick(base, keyMap) {
    if (!base) return;
    const knob = base.querySelector(".stick-knob");
    const held = { up: false, down: false, left: false, right: false };
    let pid = null;

    const apply = (ev) => {
      const rect = base.getBoundingClientRect();
      const dx = ev.clientX - (rect.left + rect.width / 2);
      const dy = ev.clientY - (rect.top + rect.height / 2);
      const dead = rect.width * 0.14;
      const next = {
        left: dx < -dead,
        right: dx > dead,
        up: dy < -dead,
        down: dy > dead,
      };
      Object.keys(next).forEach((dir) => {
        if (next[dir] === held[dir]) return;
        held[dir] = next[dir];
        this.keys[keyMap[dir]].isDown = next[dir];
      });
      // 摇杆头视觉：限位在半径 32% 内
      const max = rect.width * 0.32;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(len, max) / len;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    };

    const reset = () => {
      Object.keys(held).forEach((dir) => {
        if (!held[dir]) return;
        held[dir] = false;
        this.keys[keyMap[dir]].isDown = false;
      });
      knob.style.transform = "";
      pid = null;
    };

    base.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      pid = ev.pointerId;
      base.setPointerCapture(pid);
      apply(ev);
    });
    base.addEventListener("pointermove", (ev) => {
      if (ev.pointerId === pid) apply(ev);
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
      base.addEventListener(type, (ev) => {
        if (ev.pointerId === pid) reset();
      }),
    );
  }

  queueTap(name) {
    this.touchTaps[name] = true;
  }

  consumeTap(name) {
    if (!this.touchTaps || !this.touchTaps[name]) return false;
    this.touchTaps[name] = false;
    return true;
  }

  handleMovement() {
    const body = this.player.body;
    const x = (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
    const y = (this.keys.down.isDown ? 1 : 0) - (this.keys.up.isDown ? 1 : 0);
    const v = TMP_V1.set(x, y);
    if (v.lengthSq() > 0) {
      v.normalize().scale(this.playerStats.speed);
    }
    body.setVelocity(v.x, v.y);
    this.player.setFlipX(v.x < 0);
    this.updatePlayerWalkAnim(v.lengthSq() > 0);
  }

  // 走路感：移动时轻微 squash/拉伸循环（tween），静止时停掉并回正到基准缩放
  updatePlayerWalkAnim(moving) {
    if (moving) {
      if (this.walkTween) return;
      this.walkTween = this.tweens.add({
        targets: this.player,
        scaleX: this.playerBaseScaleX * 1.06,
        scaleY: this.playerBaseScaleY * 0.92,
        duration: 130,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      return;
    }
    this.stopPlayerWalk();
  }

  stopPlayerWalk() {
    if (!this.walkTween) return;
    this.walkTween.stop();
    this.walkTween = null;
    this.tweens.add({
      targets: this.player,
      scaleX: this.playerBaseScaleX,
      scaleY: this.playerBaseScaleY,
      duration: 90,
      ease: "Sine.easeOut",
    });
  }

  handleShooting(time) {
    if (time < this.fireAt) return;
    const sx = (this.keys.cright.isDown ? 1 : 0) - (this.keys.cleft.isDown ? 1 : 0);
    const sy = (this.keys.cdown.isDown ? 1 : 0) - (this.keys.cup.isDown ? 1 : 0);
    if (sx === 0 && sy === 0) return;
    if (sx !== 0) this.player.setFlipX(sx < 0); // 射击朝向优先于移动朝向
    const base = TMP_V1.set(sx, sy).normalize();
    this.fireTear(base);
    for (let i = 0; i < this.playerStats.spread; i += 1) {
      const angle = 0.18 + i * 0.08;
      this.fireTear(TMP_V2.copy(base).rotate(angle));
      this.fireTear(TMP_V2.copy(base).rotate(-angle));
    }
    if (this.playerStats.shots > 1) {
      const side = TMP_V2.set(-base.y, base.x).scale(13);
      this.fireTear(base, side);
    }
    this.fireAt = time + this.playerStats.fireDelay * (this.wobActive ? 0.8 : 1);
  }

  fireTear(direction, offset = null) {
    const damage = this.playerStats.damage + (this.wobActive ? 1.2 : 0);
    const tear = this.fireTearAt(
      this.player.x + direction.x * 24 + (offset ? offset.x : 0),
      this.player.y + direction.y * 24 + (offset ? offset.y : 0),
      direction,
      damage,
      this.playerStats.tearScale * (1 + Math.max(0, damage - 1) * 0.1),
    );
    if (damage >= 2.5) tear.setTint(0xffab63);
    else if (damage >= 1.6) tear.setTint(0xffd28a);
    SFX.play("shoot");
  }

  fireTearAt(x, y, direction, damage, scale = 1, options = {}) {
    const tear = this.add.sprite(x, y, "tear");
    tear.damage = damage;
    tear.life = options.life || this.playerStats.tearLife; // 射程（毫秒飞行时间），兜底用
    tear.kx = direction.x;
    tear.ky = direction.y;
    tear.pierceLeft = this.playerStats.piercing;
    const speed = options.speed || this.playerStats.tearSpeed;
    // 抛物线：地面投影 (gx,gy) 匀速前进，高度 z 受重力回落，视觉 y = gy - z
    tear.gx = x;
    tear.gy = y;
    tear.vx = direction.x * speed;
    tear.vy = direction.y * speed;
    tear.z = 1;
    tear.vz = (TEAR_GRAVITY * tear.life) / 2000; // 初速让抛物线飞行时间≈射程
    tear.setDepth(DEPTH.projectile);
    tear.setScale(scale);
    this.tears.add(tear);
    return tear;
  }

  nearestEnemy(x, y, maxDist = 400) {
    let best = null;
    let bestDist = maxDist;
    this.enemies.children.each((enemy) => {
      if (!enemy.active) return;
      const d = Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y);
      if (d < bestDist) {
        bestDist = d;
        best = enemy;
      }
    });
    return best;
  }

  updateFamiliars(time) {
    const want = this.playerStats.familiars;
    while (this.familiarSprites.length < want) {
      const familiar = this.add.image(this.player.x, this.player.y, "familiar");
      familiar.setDepth(DEPTH.actor - 1);
      familiar.setDisplaySize(26, 26);
      familiar.nextShot = time + 400;
      this.familiarSprites.push(familiar);
    }
    this.familiarSprites.forEach((familiar, index) => {
      const total = this.familiarSprites.length;
      const angle = time / 640 + (Math.PI * 2 * index) / total;
      const tx = this.player.x + Math.cos(angle) * 48;
      const ty = this.player.y + Math.sin(angle) * 42;
      familiar.x += (tx - familiar.x) * 0.16;
      familiar.y += (ty - familiar.y) * 0.16;
      if (time < familiar.nextShot) return;
      const target = this.nearestEnemy(familiar.x, familiar.y, 420);
      if (target) {
        const dir = TMP_V1.set(target.x - familiar.x, target.y - familiar.y).normalize();
        this.fireTearAt(familiar.x + dir.x * 12, familiar.y + dir.y * 12, dir, 0.5 + this.playerStats.damage * 0.25, 0.72);
        familiar.nextShot = time + 720;
      } else {
        familiar.nextShot = time + 240;
      }
    });
  }

  updateMagnet() {
    if (!this.playerStats.magnet) return;
    this.pickups.children.each((pickup) => {
      if (!pickup.active || !pickup.body) return;
      if (!["heart", "coin", "key", "bomb", "soulHeart"].includes(pickup.kind)) return;
      const distance = Phaser.Math.Distance.Between(pickup.x, pickup.y, this.player.x, this.player.y);
      if (distance < 140 && distance > 2) {
        const dir = TMP_V1.set(this.player.x - pickup.x, this.player.y - pickup.y).normalize();
        pickup.body.setVelocity(dir.x * 190, dir.y * 190);
      } else {
        pickup.body.setVelocity(0, 0);
      }
    });
  }

  fireRadialTears(amount, speed, damage) {
    for (let i = 0; i < amount; i += 1) {
      const dir = TMP_V1.set(1, 0).rotate((Math.PI * 2 * i) / amount);
      const tear = this.fireTearAt(this.player.x + dir.x * 26, this.player.y + dir.y * 26, dir, damage, this.playerStats.tearScale * 1.08, {
        speed,
        life: 980,
      });
      tear.setTint(0xffd28a);
    }
  }

  tryUseActiveItem() {
    if (!Phaser.Input.Keyboard.JustDown(this.keys.action) && !this.consumeTap("action")) return;
    const item = this.playerStats.activeItem;
    if (!item) {
      this.showToast("还没有主动道具");
      return;
    }
    if (this.playerStats.activeCharge < this.playerStats.activeChargeMax) {
      this.showToast(`${item.name} 充能不足`);
      return;
    }
    const result = item.activate(this);
    if (!result) {
      this.showToast(`${item.name} 现在没有目标`);
      return;
    }
    this.playerStats.activeCharge = 0;
    this.showToast(result);
    SFX.play("item");
    this.updateHud();
  }

  chargeActive(amount = 1) {
    if (!this.playerStats.activeItem) return;
    // 电池被动让每次充能额外 +chargeBonus（清房 +1 → +2）
    this.playerStats.activeCharge = Math.min(
      this.playerStats.activeChargeMax,
      this.playerStats.activeCharge + amount + this.playerStats.chargeBonus,
    );
  }

  // Q 使用持有物（药丸/卡牌共用一个槽位）
  tryUseHeld() {
    if (!Phaser.Input.Keyboard.JustDown(this.keys.useHeld) && !this.consumeTap("held")) return;
    this.useHeldItem();
  }

  useHeldItem() {
    const held = this.playerStats.heldItem;
    if (!held) {
      this.showToast("没有持有药丸或卡牌");
      return;
    }
    if (held.kind === "pill") {
      const effect = this.pillDeck[held.pillId] || PILL_EFFECTS[0];
      const message = effect.apply(this);
      this.identifiedPills.add(held.pillId);
      this.showToast(`药丸效果：${message}`);
    } else {
      const card = CARD_POOL.find((c) => c.id === held.cardId);
      if (!card) return;
      this.showToast(card.apply(this));
    }
    this.playerStats.heldItem = null;
    SFX.play("item");
    this.updateHud();
  }

  // 拾取新持有物时，把旧的掉回脚边（可再次拾取）
  dropHeldItem(x, y) {
    const held = this.playerStats.heldItem;
    if (!held) return;
    this.playerStats.heldItem = null;
    if (held.kind === "pill") this.spawnPickup("pill", x, y, { pillId: held.pillId });
    else this.spawnPickup("card", x, y, { cardId: held.cardId });
  }

  teleportToRoom(target) {
    this.current = { x: target.x, y: target.y };
    const rect = this.roomRect(target);
    this.player.setPosition(rect.cx, rect.cy);
    this.lastMoveAt = this.time.now;
    this.cameras.main.flash(160, 60, 50, 70);
    SFX.play("door");
    this.drawRoom();
  }

  teleportToRoomType(type) {
    const target = [...this.rooms.values()].find((room) => room.type === type);
    if (target) this.teleportToRoom(target);
  }

  teleportRandomRoom() {
    const options = [...this.rooms.values()].filter(
      (room) =>
        Math.abs(room.x) <= 3 &&
        Math.abs(room.y) <= 3 &&
        !(room.x === this.current.x && room.y === this.current.y) &&
        (room.type !== "hidden" || room.revealed),
    );
    if (!options.length) return;
    this.teleportToRoom(this.rng.pick(options));
  }

  // 「世界」卡牌：一次性揭示整层（隐藏房仍需炸开才显示）
  revealWholeMap() {
    this.rooms.forEach((room) => {
      if (Math.abs(room.x) <= 3 && Math.abs(room.y) <= 3) this.enteredRooms.add(`${room.x},${room.y}`);
    });
    this.updateHud();
  }

  // 新主动道具顶替旧的：旧的原地掉回地面可再次拾取（drawRoom 后统一落点）
  queueActiveDrop(item) {
    this.pendingActiveDrop = { item, x: this.player.x, y: Math.min(this.curRoomRect().bottom - 30, this.player.y + 34) };
  }

  flushActiveDrop() {
    const pending = this.pendingActiveDrop;
    if (!pending) return;
    this.pendingActiveDrop = null;
    this.spawnDroppedItem(pending.item, pending.x, pending.y);
  }

  // 地面上的可拾取道具（换下的主动/金宝箱开出物）
  spawnDroppedItem(item, x, y) {
    this.seenItems.add(item.name); // 掉落在当前房间即视为目击
    const stand = this.add.graphics();
    stand.fillStyle(0x161616, 0.32);
    stand.fillEllipse(x, y + 18, 62, 16);
    this.addRoomObject(stand, DEPTH.pickup - 1);

    const pickup = this.physics.add.sprite(x, y, item.iconFrame);
    this.fitDisplaySize(pickup, 42);
    pickup.kind = "droppedItem";
    pickup.item = item;
    pickup.setDepth(DEPTH.pickup);
    this.pickups.add(pickup);
    const grab = Math.min(pickup.width, pickup.height) * 0.4;
    pickup.body.setCircle(grab, (pickup.width - grab * 2) / 2, (pickup.height - grab * 2) / 2);
    return pickup;
  }

  tryPlaceBomb() {
    if (!Phaser.Input.Keyboard.JustDown(this.keys.bomb) && !this.consumeTap("bomb")) return;
    if (this.playerStats.bombs <= 0) {
      this.showToast("没有炸弹了");
      return;
    }
    this.playerStats.bombs -= 1;
    this.placeBombSprite(this.player.x, this.player.y);
  }

  // ?bombat 调试投放：豁免弹药数，与正常放置共用 sprite/引信/爆炸链路
  debugPlaceBomb() {
    this.placeBombSprite(this.player.x, this.player.y);
  }

  placeBombSprite(x, y) {
    const bomb = this.add.image(x, y, SPRITES.bomb);
    this.fitDisplaySize(bomb, 36);
    bomb.setDepth(DEPTH.actor - 1);
    bomb.baseScale = bomb.scaleX;
    bomb.fuseAt = this.time.now + BOMB_FUSE;
    this.placedBombs.push(bomb);
    this.updateHud();
  }

  // 引信：缩放脉动 + 越烧越快的白闪，到点爆炸；场上可同时存在多颗
  updateBombs(time) {
    if (!this.placedBombs.length) return;
    this.placedBombs.slice().forEach((bomb) => {
      if (!bomb.active) return;
      const remain = bomb.fuseAt - time;
      if (remain <= 0) {
        this.explodeBomb(bomb);
        return;
      }
      const pulse = 1 + Math.sin(time / 70) * 0.1 + (1 - remain / BOMB_FUSE) * 0.12;
      bomb.setScale(bomb.baseScale * pulse);
      if (remain < 950) {
        bomb.setTintFill(time % (remain < 420 ? 110 : 200) < 55 ? 0xffffff : 0xff8866);
      }
    });
    this.placedBombs = this.placedBombs.filter((bomb) => bomb.active);
  }

  explodeBomb(bomb) {
    const x = bomb.x;
    const y = bomb.y;
    bomb.destroy();
    this.explodeAt(x, y);
  }

  // 炸弹/TNT 共用的爆炸结算：伤害与击退敌人、自伤玩家、摧毁可爆障碍（TNT 连锁）、
  // 推开泪弹、炸飞店主、炸开隐藏房墙壁
  explodeAt(x, y) {
    SFX.play("boom");
    this.cameras.main.shake(170, 0.012);

    // 爆炸视觉：快速放大的闪光圆 + 外圈冲击波 + 碎屑
    const core = this.add.circle(x, y, 16, 0xfff2cc, 0.95).setDepth(DEPTH.fx);
    this.tweens.add({ targets: core, scale: BOMB_RADIUS / 14, alpha: 0, duration: 190, onComplete: () => core.destroy() });
    const ring = this.add.circle(x, y, BOMB_RADIUS * 0.55, 0xffb054, 0).setStrokeStyle(4, 0xffb054, 0.9).setDepth(DEPTH.fx);
    this.tweens.add({ targets: ring, scale: 1.9, alpha: 0, duration: 260, onComplete: () => ring.destroy() });
    this.burst(x, y, 0xffb054, 16);
    this.burst(x, y, 0x4a3a30, 8);

    // 敌人：高伤害 + 击退（hp≤0 的已死碎片跳过，防 mulligan 自爆等死亡联动递归回爆）
    this.enemies.getChildren().slice().forEach((enemy) => {
      if (!enemy.active || enemy.airborne || enemy.hp <= 0) return;
      const d = Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y);
      if (d > BOMB_RADIUS + (enemy.hitRadius || 20)) return;
      const angle = Math.atan2(enemy.y - y, enemy.x - x);
      this.damageEnemy(enemy, BOMB_DAMAGE, 0xffb054, true);
      if (enemy.active && enemy.kind !== "boss" && !enemy.noKnock) {
        enemy.knockX = Math.cos(angle) * 430;
        enemy.knockY = Math.sin(angle) * 430;
        enemy.knockUntil = this.time.now + 240;
      }
    });

    // 玩家自伤 1 整心
    if (Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) < BOMB_RADIUS) {
      this.damagePlayer(2);
    }

    // 摧毁范围内岩石/便便/壁炉并触发掉落（柱子和尖刺免疫）
    this.obstacles.getChildren().slice().forEach((obstacle) => {
      if (!obstacle.active || obstacle.bombProof) return;
      const d = Phaser.Math.Distance.Between(x, y, obstacle.x, obstacle.y);
      if (d < BOMB_RADIUS + (obstacle.blockRadius || 20) * 0.5) this.destroyObstacle(obstacle);
    });

    // 把附近的泪弹推开
    this.tears.getChildren().forEach((tear) => {
      if (!tear.active) return;
      const d = Phaser.Math.Distance.Between(x, y, tear.gx, tear.gy);
      if (d < BOMB_RADIUS + 40 && d > 1) {
        tear.vx += ((tear.gx - x) / d) * 300;
        tear.vy += ((tear.gy - y) / d) * 300;
      }
    });

    // 店主可被炸毁：商店店主掉钱（特殊店主 50% 额外 2 币加成），隐藏房店主尸体必掉 1-3 币（原版彩蛋）
    if (this.shopkeepers.length) {
      this.shopkeepers.slice().forEach((keeper) => {
        if (!keeper.active) return;
        const d = Phaser.Math.Distance.Between(x, y, keeper.x, keeper.y);
        if (d > BOMB_RADIUS + 24) return;
        this.burst(keeper.x, keeper.y, 0xd8cfc0, 14);
        keeper.destroy();
        if (keeper.secretCorpse) {
          if (keeper.room) keeper.room.corpseGone = true;
          const coins = this.rng.between(1, 3);
          for (let i = 0; i < coins; i += 1) {
            this.spawnPickup("coin", keeper.x + (i - (coins - 1) / 2) * 24, keeper.y + 16);
          }
          this.showToast("店主尸体掉出了金币……");
        } else {
          if (keeper.special && this.rng.frac() < 0.5) {
            this.spawnPickup("coin", keeper.x - 18, keeper.y + 12);
            this.spawnPickup("coin", keeper.x + 18, keeper.y + 12);
          }
          if (this.rng.frac() < 0.35) this.spawnPickup("coin", keeper.x - 14, keeper.y);
          if (this.rng.frac() < 0.3) this.spawnPickup("coin", keeper.x + 14, keeper.y);
          if (this.rng.frac() < 0.15) this.spawnPickup("soulHeart", keeper.x, keeper.y - 18);
          this.showToast("店主被炸飞了……");
        }
      });
      this.shopkeepers = this.shopkeepers.filter((keeper) => keeper.active);
    }

    // 炸开隐藏房墙壁（保留原能力）
    const target = this.findBombableHiddenRoom(x, y);
    if (target) {
      target.room.revealed = true;
      this.burst(target.x, target.y, 0xffd58a, 24);
      this.showToast("隐藏房的入口被炸开了");
      this.drawRoom();
    }
    this.updateHud();
  }

  // 障碍物碎裂反馈 + 掉落；TNT 受击后延迟起爆（可连锁引爆其他 TNT）
  destroyObstacle(obstacle) {
    if (!obstacle.active) return;
    const { x, y, kind } = obstacle;
    this.obstacleZones = this.obstacleZones.filter((zone) => zone.x !== x || zone.y !== y);
    obstacle.destroy();
    if (kind === "tnt") {
      this.burst(x, y, 0xa83232, 8);
      this.time.delayedCall(60 + this.rng.between(0, 60), () => this.explodeAt(x, y));
      return;
    }
    const debris = kind === "pot" ? 0x8a5f45 : kind === "candle" ? 0xd8b96a : 0x7a6f66;
    this.burst(x, y, debris, 12);
    this.burst(x, y, 0x2a2320, 5);
    if (kind === "rock") {
      if (obstacle.tinted) {
        // 原版染色岩掉落表：魂心 60% / 钥匙 10% / 炸弹 10% / 金宝箱 19% / 木箱 1%
        const roll = this.rng.frac();
        if (roll < 0.6) this.spawnPickup("soulHeart", x, y);
        else if (roll < 0.7) this.spawnPickup("key", x, y);
        else if (roll < 0.8) this.spawnPickup("bomb", x, y);
        else if (roll < 0.99) this.spawnPickup("goldChest", x, y);
        else this.spawnPickup("chest", x, y);
      } else if (this.rng.frac() < 0.15) this.spawnPickup("coin", x, y);
    } else if (kind === "pot") {
      if (this.rng.frac() < 0.3) this.spawnPickup(this.rng.frac() < 0.7 ? "coin" : "heart", x, y);
    } else if (kind === "candle") {
      if (this.rng.frac() < 0.25) this.spawnPickup(this.rng.frac() < 0.6 ? "coin" : "heart", x, y);
    }
  }

  // 找炸弹可炸开的隐藏房：玩家在近墙 60px 内时，取该墙最近的门槽，
  // 槽后邻居是未揭示隐藏房/超级隐藏房即可炸开（破洞贴在大房对应槽位，不再恒为墙中央）
  findBombableHiddenRoom(x, y) {
    const room = this.getRoom();
    const rect = (this.curRoom === room && this.curRect) || this.roomRect(room);
    const slots = (this.curRoom === room && this.curSlots) || this.doorSlots(room);
    const wallSlots = (label) => slots.filter((slot) => slot.label === label);
    const nearest = (cands) =>
      cands.sort((a, b) => Phaser.Math.Distance.Between(x, y, a.cx, a.cy) - Phaser.Math.Distance.Between(x, y, b.cx, b.cy))[0];
    const options = [
      { label: "north", near: y < rect.top + 60, hole: (slot) => ({ x: slot.cx, y: rect.top - 30 }) },
      { label: "south", near: y > rect.bottom - 60, hole: (slot) => ({ x: slot.cx, y: rect.bottom + 30 }) },
      { label: "west", near: x < rect.left + 60, hole: (slot) => ({ x: rect.left - 40, y: slot.cy }) },
      { label: "east", near: x > rect.right - 60, hole: (slot) => ({ x: rect.right + 40, y: slot.cy }) },
    ];
    for (const option of options) {
      if (!option.near) continue;
      const slot = nearest(wallSlots(option.label));
      if (!slot) continue;
      const target = this.rooms.get(`${slot.nx},${slot.ny}`);
      if (target && SECRET_TYPES.has(target.type) && !target.revealed) {
        const hole = option.hole(slot);
        return { room: target, x: hole.x, y: hole.y };
      }
    }
    return null;
  }

  updateEnemies(time, delta) {
    const room = this.getRoom();
    let living = 0;
    this.enemies.children.each((enemy) => {
      if (!enemy.active || !enemy.body) return; // 死亡联动（爆裂/自爆）可能在遍历中途销毁同类
      living += 1;
      if (enemy.spawnAnim < 1) {
        enemy.spawnAnim = Math.min(1, enemy.spawnAnim + delta / (enemy.kind === "boss" ? 320 : 180));
        const t = enemy.spawnAnim;
        const eased = 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
        const s = Math.max(0.05, eased);
        enemy.setScale(enemy.baseScaleX * s, enemy.baseScaleY * s);
      }
      const toPlayer = TMP_V1.set(this.player.x - enemy.x, this.player.y - enemy.y);
      const distance = Math.max(1, toPlayer.length());
      toPlayer.normalize();
      const speedScale = time < (enemy.slowUntil || 0) ? 0.46 : 1;
      const knocked = enemy.kind !== "boss" && time < (enemy.knockUntil || 0);

      if (knocked) {
        enemy.body.setVelocity(enemy.knockX, enemy.knockY);
        enemy.knockX *= 0.86;
        enemy.knockY *= 0.86;
      } else {
        // 按 kind 查处理器表分派（含 Boss 变体），无表项的走 chase
        const handler = ENEMY_HANDLERS[enemy.kind] || ENEMY_HANDLERS.chase;
        handler(this, enemy, time, toPlayer, distance, speedScale);
      }

      // 处理器里可能自毁（mulligan 自爆走 damageEnemy 立即销毁），保身体再碰物理
      if (!enemy.active || !enemy.body) return;

      this.keepInRoom(enemy);

      // 朝向与步态：按水平移动方向 flipX（飞行怪保留抖动飞行感、站桩怪与妈腿不翻转）；
      // 地面小怪随速度做轻微 squash 脉动模拟走路（出生/腾空/跳蛙滞空期间不覆盖缩放）
      const vx = enemy.body.velocity.x;
      if (!enemy.flying && !enemy.noKnock && enemy.bossVariant !== 3 && Math.abs(vx) > 12) enemy.setFlipX(vx < 0);
      if (enemy.spawnAnim >= 1 && !enemy.airborne && enemy.kind !== "boss" && !enemy.flying && enemy.kind !== "hopper") {
        const step = Math.sin((time / 160) * (enemy.speed / 100) + enemy.uid * 1.3) * 0.05;
        enemy.setScale(enemy.baseScaleX * (1 - step), enemy.baseScaleY * (1 + step));
      }
    });

    // 软推挤（原版怪群不叠罗汉）：同屏小怪两两重叠超过半径和一半时互相推开，
    // 每帧每对最多 2px；Boss/双子小体/站桩怪/被召唤怪（noPush）不参与被推
    const pushables = [];
    this.enemies.children.each((enemy) => {
      if (enemy.active && enemy.body && !enemy.noPush && enemy.kind !== "boss" && enemy.kind !== "bossSmall" && !enemy.airborne) {
        pushables.push(enemy);
      }
    });
    for (let i = 0; i < pushables.length; i += 1) {
      const a = pushables[i];
      for (let j = i + 1; j < pushables.length; j += 1) {
        const b = pushables[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDist = ((a.hitRadius || 16) + (b.hitRadius || 16)) * 0.5;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) continue;
        const d = Math.max(0.01, Math.sqrt(d2));
        const push = Math.min(((minDist - d) / minDist) * 4, 2);
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push * 0.5;
        a.y -= ny * push * 0.5;
        b.x += nx * push * 0.5;
        b.y += ny * push * 0.5;
      }
    }

    this.enemyShots.children.each((shot) => {
      shot.life -= delta;
      if (shot.life <= 0) shot.destroy();
    });

    if (living === 0 && !room.cleared && room.type !== "treasure") {
      room.cleared = true;
      this.clearedRooms.add(`${room.x},${room.y}`);
      if (room.type === "boss") {
        this.chargeActive(1);
        this.showToast("Boss 掉落了道具，通往下一层的入口打开了");
        SFX.play("clear");
        SFX.play("door");
        this.drawRoom();
        this.flashOpenedDoors();
      } else {
        this.chargeActive(1);
        this.showToast("房间已清理，门打开了");
        SFX.play("clear");
        SFX.play("door");
        this.drawRoom();
        this.flashOpenedDoors();
        this.dropReward();
      }
    }
  }

  // 清房瞬间的门反馈：开启状态的门从暗到亮淡入（锁定→开启的过渡）
  flashOpenedDoors() {
    this.doorGraphics.forEach((door) => {
      door.setAlpha(0.2);
      this.tweens.add({ targets: door, alpha: 1, duration: 280, ease: "Quad.easeOut" });
    });
  }

  // 萌死戳换帧：base 常态 / wake 攻击 / jump 腾空 / mad 狂暴。
  // Kimi 蓝圆球四脸为默认形象（enemy.easterEgg 恒真）；official 表仅在带 options.texture 的调试生成时才会用上
  setMonstroFace(enemy, face) {
    if (enemy.bossVariant !== 1 || !enemy.active) return;
    const official = { base: "monstroStand", wake: "monstroStand", jump: "monstroJump", mad: "monstroMad" };
    const kimi = { base: "kimiBoss", wake: "kimiBossWake", jump: "kimiBossJump", mad: "kimiBossMad" };
    const table = enemy.easterEgg ? kimi : official;
    enemy.setTexture(table[face] || table.base);
  }

  // 1 层 Boss 萌死戳（原版两招交替）：
  // (a) 咳弹簇——鼓腮前摇 380ms 后朝玩家咳出 6-10 发无序血弹（速度 140-220 乱数，扇面 ±32°）；
  // (b) 跳屏砸落——升空 780ms（全程落点红圈预警），落地 10 向血弹 + 100px 内玩家 1 整心；
  // 半血狂暴：提速、节奏加密、落地 12 向。原版 Monstro 不召小怪（旧版召唤已删）
  updateBoss1(enemy, time, toPlayer, distance, speedScale) {
    if (enemy.airborne) {
      if (time > enemy.jumpUntil) this.landBoss1(enemy, time);
      this.drawBossBar(enemy);
      return;
    }
    if (!enemy.enraged && enemy.hp <= enemy.maxHp / 2) {
      enemy.enraged = true;
      enemy.speed *= 1.4;
      enemy.baseTint = 0xffb8b8; // 狂暴走微红 + 狂暴帧（保持受击闪白恢复一致）
      enemy.setTint(0xffb8b8);
      this.setMonstroFace(enemy, "mad");
      this.showToast("Boss 狂暴了！");
      SFX.play("roar");
      this.cameras.main.shake(200, 0.01);
    }
    // 咳弹簇前摇（鼓腮）：停步、闪白、膨胀，然后喷无序血弹
    if (enemy.state === "windup") {
      enemy.body.setVelocity(0, 0);
      enemy.setTintFill(time % 130 < 65 ? 0xffffff : 0xffd8c8);
      const t = Phaser.Math.Clamp(1 - (enemy.stateUntil - time) / (enemy.enraged ? 260 : 380), 0, 1);
      const swell = 1 + Math.sin(t * Math.PI) * 0.14;
      enemy.setScale(enemy.baseScaleX * swell, enemy.baseScaleY * (2 - swell));
      if (time > enemy.stateUntil) {
        enemy.state = "roam";
        this.restoreEnemyTint(enemy);
        enemy.setScale(enemy.baseScaleX, enemy.baseScaleY);
        const amount = this.rng.between(6, 10);
        const baseAngle = Math.atan2(toPlayer.y, toPlayer.x);
        for (let i = 0; i < amount; i += 1) {
          const dir = TMP_V2.set(1, 0).rotate(baseAngle + this.rng.realInRange(-0.55, 0.55));
          this.enemyFire(enemy, dir, this.rng.between(140, 220), { red: true, size: 19 });
        }
        enemy.nextShot = time + (enemy.enraged ? this.rng.between(1500, 2100) : this.rng.between(2400, 3300));
        enemy.faceUntil = time + 600;
      }
      this.drawBossBar(enemy);
      return;
    }
    const wobble = Math.sin(time / 380) * 0.65;
    const move = TMP_V2.copy(toPlayer).rotate(wobble).scale(enemy.speed * speedScale);
    enemy.body.setVelocity(move.x, move.y);
    if (time > enemy.nextShot || this.debugCue === "cough") {
      enemy.state = "windup";
      enemy.stateUntil = time + (enemy.enraged ? 260 : 380);
      this.setMonstroFace(enemy, "wake");
      enemy.nextShot = time + 900; // 兜底，windup 结束会重排
    }
    if ((time > enemy.jumpAt || this.debugCue === "jump") && distance < 460) {
      // 起跳：本体升空（不可击中），落点出现红色影圈预警（整个滞空期都可见，≈780ms）
      enemy.airborne = true;
      this.setMonstroFace(enemy, "jump");
      enemy.body.enable = false;
      enemy.body.setVelocity(0, 0);
      enemy.jumpUntil = time + 780;
      enemy.jumpTarget = {
        x: Phaser.Math.Clamp(this.player.x, this.curRect.left + 60, this.curRect.right - 60),
        y: Phaser.Math.Clamp(this.player.y, this.curRect.top + 50, this.curRect.bottom - 50),
      };
      const marker = this.add.graphics();
      marker.fillStyle(0xd84a55, 0.2);
      marker.fillCircle(0, 0, 76);
      marker.lineStyle(3, 0xd84a55, 0.85);
      marker.strokeCircle(0, 0, 76);
      marker.setPosition(enemy.jumpTarget.x, enemy.jumpTarget.y);
      this.addRoomObject(marker, DEPTH.fx - 2);
      enemy.marker = marker;
      this.tweens.add({
        targets: enemy,
        scaleX: enemy.baseScaleX * 1.6,
        scaleY: enemy.baseScaleY * 1.6,
        alpha: 0.45,
        duration: 400,
        ease: "Quad.easeOut",
      });
      SFX.play("summon");
    }
    if (enemy.faceUntil && time > enemy.faceUntil) {
      enemy.faceUntil = 0;
      this.setMonstroFace(enemy, enemy.enraged ? "mad" : "base");
    }
    this.drawBossBar(enemy);
  }

  landBoss1(enemy, time) {
    enemy.airborne = false;
    enemy.body.enable = true;
    enemy.setPosition(enemy.jumpTarget.x, enemy.jumpTarget.y);
    this.setMonstroFace(enemy, enemy.enraged ? "mad" : "base");
    this.tweens.add({ targets: enemy, scaleX: enemy.baseScaleX, scaleY: enemy.baseScaleY, alpha: 1, duration: 120 });
    if (enemy.marker) {
      enemy.marker.destroy();
      enemy.marker = null;
    }
    this.cameras.main.shake(180, 0.012);
    SFX.play("boom");
    // 落地一圈血弹（原版 12 颗量级；狂暴 12 向更密）
    const amount = enemy.enraged ? 12 : 10;
    for (let i = 0; i < amount; i += 1) {
      const dir = TMP_V2.set(1, 0).rotate((Math.PI * 2 * i) / amount);
      this.enemyFire(enemy, dir, 200, { red: true, size: 19 });
    }
    if (Phaser.Math.Distance.Between(enemy.x, enemy.y, this.player.x, this.player.y) < 100) {
      this.damagePlayer(2); // 被砸中 = 1 整心
    }
    enemy.jumpAt = time + this.rng.between(enemy.enraged ? 3000 : 4200, enemy.enraged ? 4600 : 6800);
  }

  // 2 层 Boss 双子（官方 gemini 分体贴图 + 脐带连线）：
  // 大体慢速逼近，与玩家同列/同排（|dx|<60 或 |dy|<60）且距离 <420 时埋头 350ms 预警，
  // 沿对齐轴定向冲锋 500ms（4.2× 速度），冲完原地喘气 700ms；小体由脐带牵着环绕骚扰 + 单发血弹；
  // 小体先死则大体暴怒：提速并恢复环形弹幕
  updateBoss2(enemy, time, toPlayer, speedScale) {
    const twin = enemy.twin;
    if (twin && !twin.active && !enemy.enraged) {
      enemy.enraged = true;
      enemy.speed *= 1.35;
      enemy.baseTint = 0xdd5566;
      enemy.setTint(0xdd5566);
      this.showToast("大双子失去了另一半，暴怒了！");
      SFX.play("roar");
    }
    const dx = this.player.x - enemy.x;
    const dy = this.player.y - enemy.y;

    if (enemy.state === "telegraph") {
      // 埋头蓄力（原版 Gemini 冲前明显下蹲）
      enemy.body.setVelocity(0, 0);
      enemy.setTintFill(time % 130 < 65 ? 0xffffff : 0xffc8b8);
      enemy.setScale(enemy.baseScaleX * 0.94, enemy.baseScaleY * 0.84);
      if (time > enemy.stateUntil) {
        this.restoreEnemyTint(enemy);
        enemy.setScale(enemy.baseScaleX, enemy.baseScaleY);
        // 沿对齐轴直线冲撞（原版横向/竖向撞）
        enemy.chargeDir = Math.abs(dx) < 60
          ? new Phaser.Math.Vector2(0, Math.sign(dy) || 1)
          : new Phaser.Math.Vector2(Math.sign(dx) || 1, 0);
        enemy.state = "charge";
        enemy.stateUntil = time + 500;
        SFX.play("summon");
      }
    } else if (enemy.state === "charge") {
      enemy.body.setVelocity(enemy.chargeDir.x * enemy.speed * 4.2 * speedScale, enemy.chargeDir.y * enemy.speed * 4.2 * speedScale);
      if (time > enemy.stateUntil) {
        enemy.state = "rest";
        enemy.stateUntil = time + 700; // 冲完喘气硬直（原版 Gemini 的破绽窗口）
        enemy.body.setVelocity(0, 0);
      }
    } else if (enemy.state === "rest") {
      enemy.body.setVelocity(0, 0);
      if (time > enemy.stateUntil) {
        enemy.state = "roam";
        enemy.phaseAt = time + this.rng.between(enemy.enraged ? 900 : 1600, enemy.enraged ? 1500 : 2600);
      }
    } else {
      const wobble = Math.sin(time / 420) * 0.55;
      const move = TMP_V2.copy(toPlayer).rotate(wobble).scale(enemy.speed * speedScale);
      enemy.body.setVelocity(move.x, move.y);
      const dist = Math.max(1, Math.hypot(dx, dy));
      const aligned = Math.abs(dx) < 60 || Math.abs(dy) < 60;
      if ((time > enemy.phaseAt && aligned && dist < 420) || this.debugCue === "charge") {
        enemy.state = "telegraph";
        enemy.stateUntil = time + 350;
      }
    }
    // 暴怒后才恢复环形弹幕（普通态只冲锋，小体的单发弹承担远程压力）
    if (enemy.enraged && time > enemy.nextShot) {
      for (let i = 0; i < 10; i += 1) {
        const dir = TMP_V2.set(1, 0).rotate((Math.PI * 2 * i) / 10 + time / 1100);
        this.enemyFire(enemy, dir, 200, { red: true, size: 18 });
      }
      enemy.nextShot = time + 1100;
    }
    this.drawTwinTether(enemy);
    const total = enemy.hp + (twin && twin.active ? twin.hp : 0);
    this.drawBossBar(enemy, enemy.totalMaxHp ? total / enemy.totalMaxHp : null);
  }

  // 双子脐带：大体→小体的肉色连线（每帧重绘；Boss 死亡/换房时一并清理）
  drawTwinTether(enemy) {
    if (!enemy.tether) {
      enemy.tether = this.add.graphics();
      enemy.tether.setDepth(DEPTH.actor - 1);
    }
    const g = enemy.tether;
    g.clear();
    const twin = enemy.twin;
    if (!twin || !twin.active || !enemy.active) return;
    g.lineStyle(7, 0x9c6a5e, 0.5);
    g.lineBetween(enemy.x, enemy.y + 6, twin.x, twin.y + 4);
    g.lineStyle(3, 0xc9988a, 0.55);
    g.lineBetween(enemy.x, enemy.y + 6, twin.x, twin.y + 4);
  }

  // 双子小体：脐带牵着环绕骚扰 + 周期单发血弹；离大体 >180 时加速回缩；大体死后狂暴加速并接过血条
  updateBossSmall(enemy, time, toPlayer, speedScale) {
    const leader = enemy.twinLeader;
    if (leader && !leader.active && !enemy.enraged) {
      enemy.enraged = true;
      enemy.speed *= 1.65;
      enemy.baseTint = 0xdd5566;
      enemy.setTint(0xdd5566);
      this.makeBossBar(enemy, BOSS_NAMES.twins);
      this.showToast("小双子狂暴了！");
      SFX.play("roar");
      enemy.twinLeader = null;
    }
    if (leader && leader.active) {
      // 脐带约束：距离 >180 优先拉回大体身边，否则环绕玩家
      const leadDist = Phaser.Math.Distance.Between(enemy.x, enemy.y, leader.x, leader.y);
      if (leadDist > 180) {
        const back = TMP_V2.set(leader.x - enemy.x, leader.y - enemy.y).normalize().scale(enemy.speed * 1.35 * speedScale);
        enemy.body.setVelocity(back.x, back.y);
      } else {
        const wobble = Math.sin(time / 300 + enemy.uid) * 0.5;
        const move = TMP_V3.copy(toPlayer).rotate(wobble).scale(enemy.speed * speedScale);
        enemy.body.setVelocity(move.x, move.y);
      }
      if (time > enemy.nextShot) {
        this.enemyFire(enemy, toPlayer, 185, { red: true, size: 15 });
        enemy.nextShot = time + this.rng.between(1600, 2400);
      }
    } else {
      const wobble = Math.sin(time / 300 + enemy.uid) * 0.5;
      const move = TMP_V3.copy(toPlayer).rotate(wobble).scale(enemy.speed * speedScale);
      enemy.body.setVelocity(move.x, move.y);
      if (time > enemy.nextShot) {
        this.enemyFire(enemy, toPlayer, 195, { red: true, size: 15 });
        enemy.nextShot = time + (enemy.enraged ? 900 : 1500);
      }
    }
    if (enemy.bar) this.drawBossBar(enemy);
  }

  // 1 层 Boss 池·粪山：缓慢追人，周期三连冲撞（白闪预警、每段重新瞄准），
  // 偶尔生 1-2 只小便便怪（crawler 换 poop 贴图缩小）；半血狂暴加速，死亡时放一圈弹幕
  updateDingle(enemy, time, toPlayer, distance, speedScale) {
    if (!enemy.enraged && enemy.hp <= enemy.maxHp / 2) {
      enemy.enraged = true;
      enemy.speed *= 1.3;
      enemy.baseTint = 0xdd5566;
      enemy.setTint(0xdd5566);
      this.showToast("粪山狂暴了！");
      SFX.play("roar");
      this.cameras.main.shake(200, 0.01);
    }
    if (enemy.state === "telegraph") {
      enemy.body.setVelocity(0, 0);
      enemy.setTintFill(time % 160 < 80 ? 0xffcc88 : 0xffffff);
      if (time > enemy.stateUntil) {
        enemy.state = "charge";
        enemy.dashesLeft = enemy.enraged ? 4 : 3;
        enemy.stateUntil = 0; // 立刻进入第一段冲刺
        this.restoreEnemyTint(enemy);
        // 原版粪山冲锋前的 3 颗连射（散射血弹糊脸预警）
        const baseAngle = Math.atan2(toPlayer.y, toPlayer.x);
        for (let i = -1; i <= 1; i += 1) {
          this.enemyFire(enemy, TMP_V2.set(1, 0).rotate(baseAngle + i * 0.24), 185, { red: true, size: 17 });
        }
        SFX.play("summon");
      }
      this.drawBossBar(enemy);
      return;
    }
    if (enemy.state === "charge") {
      if (time > enemy.stateUntil) {
        if (enemy.dashesLeft > 0) {
          enemy.dashesLeft -= 1;
          enemy.chargeDir = toPlayer.clone(); // 每段冲刺重新瞄准
          enemy.stateUntil = time + 460;
          SFX.play("summon");
        } else {
          enemy.state = "roam";
          enemy.chargeDir = null;
          enemy.body.setVelocity(0, 0);
          enemy.phaseAt = time + this.rng.between(enemy.enraged ? 2000 : 2800, enemy.enraged ? 3000 : 4000);
        }
      }
      if (enemy.chargeDir) {
        enemy.body.setVelocity(enemy.chargeDir.x * enemy.speed * 4.6 * speedScale, enemy.chargeDir.y * enemy.speed * 4.6 * speedScale);
      }
      this.drawBossBar(enemy);
      return;
    }
    const wobble = Math.sin(time / 420 + enemy.uid) * 0.4;
    const move = TMP_V2.copy(toPlayer).rotate(wobble).scale(enemy.speed * speedScale);
    enemy.body.setVelocity(move.x, move.y);
    if (time > enemy.phaseAt && distance < 560) {
      enemy.state = "telegraph";
      enemy.stateUntil = time + 620;
    }
    if (time > enemy.summonAt) {
      let minions = 0;
      this.enemies.children.each((other) => {
        if (other.active && other.kind !== "boss") minions += 1;
      });
      if (minions < 3) {
        SFX.play("summon");
        const amount = this.rng.between(1, 2);
        for (let i = 0; i < amount; i += 1) {
          this.spawnEnemy("crawler", enemy.x + this.rng.between(-56, 56), enemy.y + this.rng.between(-48, 48), {
            noChampion: true,
            noPush: true,
            texture: "poop",
            tint: 0xb0784a,
            size: 30,
          });
        }
      }
      enemy.summonAt = time + 8000;
    }
    this.drawBossBar(enemy);
  }

  // 粪山死亡：放一圈弹幕（在 damageEnemy 死亡分支里触发）
  explodeDingle(enemy) {
    const amount = enemy.enraged ? 14 : 10;
    for (let i = 0; i < amount; i += 1) {
      const dir = TMP_V2.set(1, 0).rotate((Math.PI * 2 * i) / amount);
      this.enemyFire(enemy, dir, 190, { red: true, size: 19 });
    }
    SFX.play("boom");
  }

  // 2 层 Boss 池·古迪：房间中央站桩不动（大体型），周期交替扇形（朝玩家）/径向弹幕，
  // 场上苍蝇 <3 时召唤；半血狂暴弹幕加密
  updateGurdy(enemy, time, toPlayer) {
    enemy.body.setVelocity(0, 0);
    if (!enemy.enraged && enemy.hp <= enemy.maxHp / 2) {
      enemy.enraged = true;
      enemy.baseTint = 0xdd5566;
      enemy.setTint(0xdd5566);
      this.showToast("古迪狂暴了！");
      SFX.play("roar");
      this.cameras.main.shake(200, 0.01);
    }
    if (time > enemy.nextShot) {
      if (enemy.volleyToggle) {
        // 扇形：朝玩家方向喷一列血弹
        const baseAngle = Math.atan2(toPlayer.y, toPlayer.x);
        const amount = enemy.enraged ? 5 : 3;
        for (let i = 0; i < amount; i += 1) {
          const dir = TMP_V2.set(1, 0).rotate(baseAngle + (i - (amount - 1) / 2) * 0.22);
          this.enemyFire(enemy, dir, 195, { red: true, size: 19 });
        }
      } else {
        // 径向：一整圈血弹
        const amount = enemy.enraged ? 14 : 9;
        for (let i = 0; i < amount; i += 1) {
          const dir = TMP_V2.set(1, 0).rotate((Math.PI * 2 * i) / amount + time / 1200);
          this.enemyFire(enemy, dir, 175, { red: true, size: 19 });
        }
      }
      enemy.volleyToggle = !enemy.volleyToggle;
      enemy.nextShot = time + (enemy.enraged ? 1000 : 1500);
    }
    if (time > enemy.summonAt) {
      let flies = 0;
      this.enemies.children.each((other) => {
        if (other.active && other.kind === "fly") flies += 1;
      });
      if (flies < 3) {
        SFX.play("summon");
        for (let i = 0; i < 2; i += 1) {
          this.spawnEnemy("fly", enemy.x + this.rng.between(-70, 70), enemy.y + this.rng.between(-56, 56), { noChampion: true, noPush: true });
        }
      }
      enemy.summonAt = time + 6000;
    }
    this.drawBossBar(enemy);
  }

  // 3 层终局 Boss 妈腿：周期踩下（警示影 → 范围伤害 + 弹幕），踩下时可打脚；期间召唤小怪
  updateBoss3(enemy, time) {
    if (!enemy.enraged && enemy.hp <= enemy.maxHp / 2) {
      enemy.enraged = true;
      enemy.baseTint = 0xd85b6d;
      enemy.setTint(0xd85b6d);
      this.showToast("妈腿狂暴了！");
      SFX.play("roar");
      this.cameras.main.shake(200, 0.01);
    }
    enemy.body.setVelocity(0, 0);
    if (enemy.bossState === "idle" && time > enemy.nextStomp) {
      enemy.bossState = "warn";
      enemy.stateUntil = time + (enemy.enraged ? 560 : 720);
      enemy.stompTarget = {
        x: Phaser.Math.Clamp(this.player.x, this.curRect.left + 70, this.curRect.right - 70),
        y: Phaser.Math.Clamp(this.player.y, this.curRect.top + 70, this.curRect.bottom - 50),
      };
      const marker = this.add.graphics();
      marker.fillStyle(0x30101a, 0.4);
      marker.fillEllipse(0, 0, 150, 110);
      marker.lineStyle(3, 0xd84a55, 0.85);
      marker.strokeEllipse(0, 0, 150, 110);
      marker.setPosition(enemy.stompTarget.x, enemy.stompTarget.y);
      this.addRoomObject(marker, DEPTH.fx - 2);
      enemy.marker = marker;
      SFX.play("summon");
    } else if (enemy.bossState === "warn" && time > enemy.stateUntil) {
      enemy.bossState = "down";
      enemy.stateUntil = time + (enemy.enraged ? 1000 : 1350);
      enemy.setPosition(enemy.stompTarget.x, enemy.stompTarget.y);
      enemy.airborne = false; // 攻击窗口：脚落地后可被打
      enemy.body.enable = true;
      enemy.setAlpha(1);
      if (enemy.marker) {
        enemy.marker.destroy();
        enemy.marker = null;
      }
      this.cameras.main.shake(190, 0.014);
      SFX.play("boom");
      const amount = enemy.enraged ? 12 : 8;
      for (let i = 0; i < amount; i += 1) {
        const dir = TMP_V2.set(1, 0).rotate((Math.PI * 2 * i) / amount);
        this.enemyFire(enemy, dir, 190, { red: true, size: 19 });
      }
      if (Phaser.Math.Distance.Between(enemy.x, enemy.y, this.player.x, this.player.y) < 95) {
        this.damagePlayer(2); // 被踩中 = 1 整心
      }
    } else if (enemy.bossState === "down" && time > enemy.stateUntil) {
      enemy.bossState = "idle";
      enemy.airborne = true;
      enemy.body.enable = false;
      enemy.setAlpha(0.18);
      enemy.setPosition(this.curRect.cx, this.curRect.top + 46);
      enemy.nextStomp = time + this.rng.between(enemy.enraged ? 1500 : 2300, enemy.enraged ? 2300 : 3300);
    }
    if (time > enemy.summonAt) {
      let minions = 0;
      this.enemies.children.each((other) => {
        if (other.active && other.kind !== "boss") minions += 1;
      });
      if (minions < 4) {
        SFX.play("summon");
        for (let i = 0; i < 2; i += 1) {
          const kind = this.rng.frac() < 0.5 ? "crawler" : "fly";
          this.spawnEnemy(
            kind,
            this.rng.between(this.curRect.left + 90, this.curRect.right - 90),
            this.rng.between(this.curRect.top + 90, this.curRect.bottom - 90),
            { noChampion: true, noPush: true },
          );
        }
      }
      enemy.summonAt = time + 6500;
    }
    this.drawBossBar(enemy);
  }

  updateCharger(enemy, time, toPlayer, distance, speedScale) {
    if (enemy.state === "charge") {
      if (time > enemy.stateUntil) {
        enemy.state = "roam";
        enemy.phaseAt = time + this.rng.between(1500, 2400);
        this.restoreEnemyTint(enemy);
        enemy.body.setVelocity(toPlayer.x * enemy.speed * speedScale, toPlayer.y * enemy.speed * speedScale);
        return;
      }
      enemy.body.setVelocity(enemy.chargeDir.x * enemy.speed * 4.8 * speedScale, enemy.chargeDir.y * enemy.speed * 4.8 * speedScale);
      return;
    }
    if (enemy.state === "telegraph") {
      enemy.body.setVelocity(0, 0);
      enemy.setTintFill(time % 140 < 70 ? 0xffb088 : 0xffffff);
      if (time > enemy.stateUntil) {
        enemy.state = "charge";
        enemy.stateUntil = time + 520;
        enemy.chargeDir = toPlayer.clone();
        this.restoreEnemyTint(enemy);
        SFX.play("summon");
      }
      return;
    }
    enemy.body.setVelocity(toPlayer.x * enemy.speed * speedScale, toPlayer.y * enemy.speed * speedScale);
    if (time > enemy.phaseAt && distance < 340) {
      enemy.state = "telegraph";
      enemy.stateUntil = time + 430;
    }
  }

  restoreEnemyTint(enemy) {
    if (!enemy.active) return;
    if (enemy.baseTint) enemy.setTint(enemy.baseTint);
    else enemy.clearTint();
  }

  // ── 新怪行为方法（ENEMY_HANDLERS 的就近封装）──────────────────────────

  // 霍夫 Horf 射击状态机：roam 站桩待机 → windup 前摇闪白 380ms → 单发弹 → 冷却 1.4-2.2s
  horfVolley(enemy, time, toPlayer) {
    if (enemy.state === "windup") {
      enemy.setTintFill(time % 120 < 60 ? 0xffffff : 0xffd8d8);
      const t = Phaser.Math.Clamp(1 - (enemy.stateUntil - time) / 380, 0, 1);
      enemy.setScale(enemy.baseScaleX * (1 + t * 0.16), enemy.baseScaleY * (1 + t * 0.16));
      if (time > enemy.stateUntil) {
        this.restoreEnemyTint(enemy);
        enemy.setScale(enemy.baseScaleX, enemy.baseScaleY);
        enemy.state = "roam";
        this.enemyFire(enemy, toPlayer, 230);
        enemy.nextShot = time + this.rng.between(1400, 2200);
      }
      return;
    }
    if (time > enemy.nextShot) {
      enemy.state = "windup";
      enemy.stateUntil = time + 380;
    }
  }

  // 龟壳 Host 开合状态机：roam 缩壳无敌（压暗）→ windup 抬头前摇 350ms → open 露肉 900ms
  // （invuln=false 可被泪弹打）并 ±20° 扇射 3 发 → 合壳，冷却 2.5-3.5s
  hostShell(enemy, time, toPlayer) {
    if (enemy.state === "open") {
      enemy.invuln = false;
      if (time > enemy.stateUntil) enemy.state = "roam";
      return;
    }
    if (enemy.state === "windup") {
      enemy.invuln = true;
      enemy.setTintFill(time % 130 < 65 ? 0xffffff : 0xffe0c8);
      if (time > enemy.stateUntil) {
        enemy.state = "open";
        enemy.stateUntil = time + 900;
        enemy.invuln = false;
        enemy.appliedShellTint = null; // 已恢复亮色，回壳时需重新压暗
        this.restoreEnemyTint(enemy);
        const baseAngle = Math.atan2(toPlayer.y, toPlayer.x);
        for (let i = -1; i <= 1; i += 1) {
          this.enemyFire(enemy, TMP_V2.set(1, 0).rotate(baseAngle + i * Phaser.Math.DegToRad(20)), 190);
        }
        enemy.nextShot = time + this.rng.between(2500, 3500);
      }
      return;
    }
    // 壳态：无敌 + 压暗（精英保留底色只降明度，别把红蓝黑精英藏成普通怪）
    enemy.invuln = true;
    const shellTint = enemy.baseTint ? Phaser.Display.Color.IntegerToColor(enemy.baseTint).darken(45).color : 0x63503e;
    if (enemy.appliedShellTint !== shellTint) {
      enemy.appliedShellTint = shellTint;
      enemy.setTint(shellTint);
    }
    if (time > enemy.nextShot || this.debugCue === "open") {
      enemy.state = "windup";
      enemy.stateUntil = time + 350;
    }
  }

  // 跳蛙 Hopper：待机 400-700ms → 朝玩家方向小跳（起跳即定型、滞空可越障、
  // 用 squash/拉伸模拟抛物线 z 高度），落地挤压一下再循环
  updateHopper(enemy, time, toPlayer, distance) {
    if (enemy.state === "hop") {
      const t = Phaser.Math.Clamp((time - enemy.hopStart) / enemy.hopDur, 0, 1);
      const lift = Math.sin(t * Math.PI);
      enemy.setScale(enemy.baseScaleX * (1 + lift * 0.32), enemy.baseScaleY * (1 + lift * 0.32));
      if (t >= 1) {
        enemy.state = "roam";
        enemy.phaseAt = time + this.rng.between(400, 700);
        enemy.body.setVelocity(0, 0);
        enemy.setScale(enemy.baseScaleX * 1.18, enemy.baseScaleY * 0.78); // 落地挤压
        this.time.delayedCall(90, () => {
          if (enemy.active) enemy.setScale(enemy.baseScaleX, enemy.baseScaleY);
        });
      }
      return;
    }
    enemy.body.setVelocity(0, 0);
    if (time > enemy.phaseAt) {
      enemy.state = "hop";
      enemy.hopStart = time;
      enemy.hopDur = this.rng.between(380, 470);
      // 起跳即定型方向与力度（原版跳向起跳瞬间位置，滞空不二次瞄准）
      const hopSpeed = Math.min(320, Math.max(170, (distance / enemy.hopDur) * 1000 * 1.1));
      enemy.body.setVelocity(toPlayer.x * hopSpeed, toPlayer.y * hopSpeed);
    }
  }

  // 自弃者 Mulligan：慢速逃向玩家对角线（背向 ±40° 摆动，原版躲人+偶尔乱撞感）；
  // 距玩家 <150 时每 3s 有 35% 概率点燃自爆（320ms 引线前摇，damageEnemy 分支起爆+召 2 苍蝇）
  updateMulligan(enemy, time, toPlayer, distance, speedScale) {
    if (enemy.state === "fuse") {
      enemy.body.setVelocity(0, 0);
      enemy.setTintFill(time % 110 < 55 ? 0xffffff : 0xffb066);
      if (time > enemy.stateUntil) {
        enemy.selfBoom = true;
        this.damageEnemy(enemy, 9999, 0xffcc88); // 走正常死亡结算，由死亡分支起爆
      }
      return;
    }
    const diagonal = enemy.uid % 2 ? 0.45 : -0.45;
    const wobble = Math.sin(time / 300 + enemy.uid * 2.1) * 0.7;
    const dir = TMP_V2.copy(toPlayer).scale(-1).rotate(diagonal + wobble);
    enemy.body.setVelocity(dir.x * enemy.speed * speedScale, dir.y * enemy.speed * speedScale);
    if (distance < 150 && time > enemy.phaseAt) {
      enemy.phaseAt = time + 3000;
      if (this.rng.frac() < 0.35) {
        enemy.state = "fuse";
        enemy.stateUntil = time + 320;
      }
    }
  }

  // 爆蝇死亡引线：原地红圈膨胀 120ms（前摇提示，给玩家一瞬反应），随后 explodeBoomFly 结算
  boomFlyFuse(x, y) {
    const fuse = this.add.circle(x, y, 10, 0xe0563a, 0.5);
    fuse.setDepth(DEPTH.fx);
    this.tweens.add({ targets: fuse, radius: 46, alpha: 0.85, duration: 120, onComplete: () => fuse.destroy() });
    this.time.delayedCall(120, () => this.explodeBoomFly(x, y));
  }

  // 爆蝇爆炸（比炸弹小圈）：半径 64 内敌我都伤——原版 Boom Fly 爆炸不分敌我
  explodeBoomFly(x, y) {
    if (this.gameEnded) return;
    SFX.play("boom");
    const radius = 64;
    const core = this.add.circle(x, y, 12, 0xfff2cc, 0.9).setDepth(DEPTH.fx);
    this.tweens.add({ targets: core, scale: radius / 12, alpha: 0, duration: 170, onComplete: () => core.destroy() });
    const ring = this.add.circle(x, y, radius * 0.5, 0xffb054, 0).setStrokeStyle(4, 0xffb054, 0.9).setDepth(DEPTH.fx);
    this.tweens.add({ targets: ring, scale: 2, alpha: 0, duration: 240, onComplete: () => ring.destroy() });
    this.burst(x, y, 0xffb054, 10);
    this.enemies.getChildren().slice().forEach((other) => {
      if (!other.active || other.airborne) return;
      if (Phaser.Math.Distance.Between(x, y, other.x, other.y) < radius + (other.hitRadius || 20)) {
        this.damageEnemy(other, 6, 0xffb054, true);
      }
    });
    if (Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) < radius) {
      this.damagePlayer(1);
    }
  }

  // 敌子弹统一入口：默认小蓝弹（普通怪不变）；opts.red 换 Boss 级大红血弹、opts.size 定显示边长
  enemyFire(enemy, direction, speed, opts = {}) {
    // 小怪弹=血红小弹 enemyShotSmall（原版 f_0106 血色弹）；Boss 弹=加大红弹 enemyShotRed
    const shot = this.physics.add.sprite(enemy.x, enemy.y, opts.red ? "enemyShotRed" : "enemyShotSmall");
    shot.life = 2500;
    shot.setDepth(DEPTH.projectile);
    if (opts.size) shot.setDisplaySize(opts.size, opts.size);
    this.enemyShots.add(shot);
    // 判定圈在源像素下定：显示缩放后世界半径≈尺寸×0.42（小怪红弹 6 / Boss 红弹 8.5 与贴图对应）
    shot.body.setCircle(opts.red ? 8.5 : 6);
    shot.body.setVelocity(direction.x * speed, direction.y * speed);
  }

  // Boss 血条：底部居中横条，深色底 + 描边 + 红色填充（Boss 名由 makeBossBar 放在条上方）
  drawBossBar(enemy, pctOverride = null) {
    if (!enemy.bar) return;
    const pct = Phaser.Math.Clamp(pctOverride != null ? pctOverride : enemy.hp / enemy.maxHp, 0, 1);
    const bar = enemy.bar;
    bar.clear();
    bar.fillStyle(0x0d0708, 0.82);
    bar.fillRoundedRect(258, 492, 444, 18, 9);
    bar.lineStyle(2, 0x4a3034, 1);
    bar.strokeRoundedRect(258, 492, 444, 18, 9);
    if (pct > 0.003) {
      bar.fillStyle(0xb03038, 1);
      bar.fillRoundedRect(262, 496, Math.max(6, 436 * pct), 10, 5);
    }
  }

  // 泪弹抛物线：手动积分地面投影 (gx,gy) 与高度 z，视觉 y = gy - z
  updateTears(delta) {
    if (!this.tears.getChildren().length) return;
    const dt = Math.min(0.05, delta / 1000);
    this.tears.getChildren().slice().forEach((tear) => {
      if (!tear.active) return;
      tear.gx += tear.vx * dt;
      tear.gy += tear.vy * dt;
      tear.vz -= TEAR_GRAVITY * dt;
      tear.z += tear.vz * dt;
      tear.life -= delta;

      // 撞墙（当前房外接矩形外 8px 余量，大房按整房算）
      const tRect = this.curRect || ROOM;
      if (tear.gx < tRect.left - 8 || tear.gx > tRect.right + 8 || tear.gy < tRect.top - 8 || tear.gy > tRect.bottom + 8) {
        this.tearSplash(tear.gx, tear.gy, tear.scaleX);
        tear.destroy();
        return;
      }
      // 撞障碍物（地面投影 + 高度容忍；便便/壁炉会被打烂）
      if (tear.z < TEAR_HIT_HEIGHT && this.tearHitObstacles(tear)) {
        this.tearSplash(tear.gx, tear.gy - Math.max(0, tear.z), tear.scaleX);
        tear.destroy();
        return;
      }
      // 撞敌人（地面投影判定，敌人视为有一定高度容忍）
      if (this.tearHitEnemies(tear)) return; // hitEnemy 已处理溅射/销毁/穿透
      // 落地或射程耗尽：溅射
      if (tear.z <= 0 || tear.life <= 0) {
        this.tearSplash(tear.gx, tear.gy, tear.scaleX);
        tear.destroy();
        return;
      }
      tear.setPosition(tear.gx, tear.gy - tear.z);
    });
  }

  tearHitObstacles(tear) {
    const pad = 5 + tear.scaleX * 2;
    for (const obstacle of this.obstacles.getChildren()) {
      // 尖刺/沟壑贴地，泪弹从上方飞过
      if (!obstacle.active || obstacle.kind === "spikes" || obstacle.kind === "pit") continue;
      const d = Phaser.Math.Distance.Between(tear.gx, tear.gy, obstacle.x, obstacle.y);
      if (d >= (obstacle.blockRadius || 22) + pad) continue;
      if (obstacle.kind === "pot") {
        // 便便三段退化：大→中→小→碎，中/小形态按基准 0.7/0.45 缩放，
        // 每段 30% 概率掉硬币/心（原版规则）；彻底打碎走 destroyObstacle 掉落
        obstacle.hp -= 1;
        this.burst(obstacle.x, obstacle.y, 0xb47b54, 4);
        if (obstacle.hp <= 0) this.destroyObstacle(obstacle);
        else this.degradePot(obstacle);
      } else if (obstacle.kind === "candle" || obstacle.kind === "tnt") {
        obstacle.hp -= 1;
        this.burst(obstacle.x, obstacle.y, obstacle.kind === "tnt" ? 0xa83232 : 0xd8b96a, 4);
        if (obstacle.hp <= 0) this.destroyObstacle(obstacle);
      }
      return true; // 岩石/柱子只挡泪弹，不会被打坏
    }
    return false;
  }

  // 便便受击退化：显示与判定圈同步缩小（potBase 为放置时基准尺寸），30% 概率掉硬币/心
  degradePot(obstacle) {
    const stage = obstacle.hp === 2 ? 0.7 : 0.45;
    const size = obstacle.potBase * stage;
    this.fitDisplaySize(obstacle, size);
    obstacle.refreshBody();
    const dw = obstacle.displayWidth;
    const dh = obstacle.displayHeight;
    const bodyRadius = Math.min(dw, dh) * 0.44;
    obstacle.body.setCircle(bodyRadius, dw / 2 - bodyRadius, dh / 2 - bodyRadius);
    obstacle.blockRadius = bodyRadius;
    if (this.rng.frac() < 0.3) this.spawnPickup(this.rng.frac() < 0.7 ? "coin" : "heart", obstacle.x, obstacle.y);
  }

  tearHitEnemies(tear) {
    for (const enemy of this.enemies.getChildren()) {
      if (!enemy.active || enemy.airborne) continue;
      const d = Phaser.Math.Distance.Between(tear.gx, tear.gy, enemy.x, enemy.y);
      if (d < (enemy.hitRadius || 20) + 5 + tear.scaleX * 2) {
        this.hitEnemy(tear, enemy);
        return true;
      }
    }
    return false;
  }

  // 泪弹落地/命中的水花：小圆环放大淡出 + 地面水渍
  tearSplash(x, y, scale = 1) {
    const ring = this.add.circle(x, y, 4 + 3 * scale, 0x9fd4e8, 0.65).setDepth(DEPTH.fx);
    this.tweens.add({ targets: ring, scale: 2.3, alpha: 0, duration: 190, onComplete: () => ring.destroy() });
    const splat = this.add.ellipse(x, y, 16 * scale, 7 * scale, 0x4ea1bd, 0.38).setDepth(DEPTH.fx - 1);
    this.tweens.add({ targets: splat, alpha: 0, duration: 300, onComplete: () => splat.destroy() });
  }

  hitEnemy(tear, enemy) {
    if (!tear.active || !enemy.active) return;
    if (tear.hitSet && tear.hitSet.has(enemy.uid)) return;
    const kx = tear.kx || 0;
    const ky = tear.ky || 0;
    this.tearSplash(enemy.x, enemy.y - 8, tear.scaleX || 1); // 命中敌人时在其处溅射
    this.damageEnemy(enemy, tear.damage, 0xa8d8e8, true);
    if (enemy.active && enemy.kind !== "boss" && !enemy.noKnock) {
      const power = 200 * this.playerStats.knockback;
      enemy.knockX = kx * power;
      enemy.knockY = ky * power;
      enemy.knockUntil = this.time.now + 130;
    }
    if ((tear.pierceLeft || 0) > 0) {
      tear.pierceLeft -= 1;
      if (!tear.hitSet) tear.hitSet = new Set();
      tear.hitSet.add(enemy.uid);
    } else {
      tear.destroy();
    }
  }

  damageEnemy(enemy, amount, color = 0xa8d8e8, flash = true) {
    if (!enemy.active) return;
    // 龟缩态（Host 缩壳）：无敌，泪弹只溅提示性火花（硬直/弹偏动画省掉，手感差别不大）
    if (enemy.invuln) {
      this.burst(enemy.x, enemy.y, 0xb8b8b8, 3);
      SFX.play("hit");
      return;
    }
    enemy.hp -= amount;
    enemy.setTintFill(0xffffff);
    this.time.delayedCall(70, () => this.restoreEnemyTint(enemy));
    this.burst(enemy.x, enemy.y, color, flash ? 5 : 8);
    if (enemy.hp <= 0) {
      this.stats.kills += 1;
      if (enemy.bar) enemy.bar.destroy();
      if (enemy.barLabel) enemy.barLabel.destroy();
      if (enemy.marker) {
        enemy.marker.destroy();
        enemy.marker = null;
      }
      if (enemy.tether) {
        enemy.tether.destroy();
        enemy.tether = null;
      }
      this.burst(enemy.x, enemy.y, 0xb76658, enemy.kind === "boss" ? 22 : 10);
      this.spawnBloodDecal(enemy.x, enemy.y, enemy.kind === "boss"); // Boss 留下更大一滩
      // ── 死亡联动（原版行为）──
      if (enemy.kind === "bigSpider") {
        // 大蜘蛛死后裂成两只小蛛（尸体位 ±20px）
        for (let i = 0; i < 2; i += 1) {
          this.spawnEnemy("spider", enemy.x + (i ? 20 : -20), enemy.y + this.rng.between(-12, 12), { noChampion: true, noPush: true });
        }
      }
      if (enemy.kind === "boomFly") {
        this.boomFlyFuse(enemy.x, enemy.y); // 延迟 120ms 起爆
      }
      if (enemy.kind === "sucker") {
        // 吸盘死亡十字四向弹（±十字）
        for (let i = 0; i < 4; i += 1) {
          this.enemyFire(enemy, TMP_V2.set(1, 0).rotate((Math.PI / 2) * i), 190);
        }
      }
      if (enemy.kind === "mulligan" && enemy.selfBoom) {
        // 自弃者自爆：原地起爆（不分敌我），随后召 2 只苍蝇
        const { x, y } = enemy;
        this.explodeAt(x, y);
        this.time.delayedCall(150, () => {
          if (this.gameEnded) return;
          for (let i = 0; i < 2; i += 1) {
            this.spawnEnemy("fly", x + (i ? 24 : -24), y + this.rng.between(-10, 10), { noChampion: true, noPush: true });
          }
        });
      }
      if (enemy.kind === "boss" && enemy.bossKind === "dingle") {
        this.explodeDingle(enemy); // 粪山死亡放一圈弹幕
      }
      // 精英掉落按色区分（CHAMPION_TYPES：红=红心 / 蓝=魂心 / 黑=炸弹 / 金=双倍掉落）
      if (enemy.isChampion) {
        const def = CHAMPION_TYPES[enemy.championColor] || CHAMPION_TYPES.gold;
        this.burst(enemy.x, enemy.y, def.tint, 12); // 死亡特效与精英同色
        if (def.drop === "heart") this.spawnPickup("heart", enemy.x, enemy.y);
        else if (def.drop === "soulHeart") this.spawnPickup("soulHeart", enemy.x, enemy.y);
        else if (def.drop === "bomb") this.spawnPickup("bomb", enemy.x, enemy.y);
        else {
          for (let i = 0; i < 4; i += 1) {
            this.spawnPickup("coin", enemy.x + (i - 1.5) * 22, enemy.y);
          }
          for (let i = 0; i < 2; i += 1) {
            if (this.rng.frac() < 0.35) this.spawnPickup("heart", enemy.x + (i ? 26 : -26), enemy.y - 22);
          }
        }
      }
      if (enemy.kind !== "boss" && this.rng.frac() < this.playerStats.lifesteal && this.playerStats.hp < this.playerStats.maxHp) {
        this.playerStats.hp = Math.min(this.playerStats.maxHp, this.playerStats.hp + 2); // 恢复 1 整心
        this.burst(this.player.x, this.player.y, 0x7ec86a, 8);
        this.updateHud();
      }
      SFX.play("die");
      this.tweens.killTweensOf(enemy); // 防游离 tween（如 Boss 跳跃缩放）操作已销毁对象
      enemy.destroy();
    } else {
      SFX.play("hit");
    }
  }

  touchEnemy(player, enemy) {
    if (enemy.noTouchDamage) return; // 原版 Host 本体无接触伤害（弹幕才有威胁）
    this.damagePlayer(this.time.now < (enemy.weakenUntil || 0) ? 1 : enemy.touch || 1);
  }

  hitByShot(player, shot) {
    shot.destroy();
    this.damagePlayer(1);
  }

  touchObstacle(player, obstacle) {
    if (obstacle.kind !== "spikes") return;
    this.damagePlayer(2); // 尖刺 = 1 整心
  }

  projectileHitObstacle(projectile) {
    if (!projectile.active) return;
    projectile.destroy(); // 只剩敌子弹走物理碰撞；玩家泪弹在 updateTears 里手动判定
  }

  damagePlayer(amount) {
    if (this.time.now < this.invulnerableUntil || this.gameEnded) return;
    let remaining = amount;
    while (remaining > 0) {
      if (this.playerStats.soulHp > 0) {
        this.playerStats.soulHp -= 1;
      } else {
        this.playerStats.hp -= 1;
      }
      remaining -= 1;
    }
    this.invulnerableUntil = this.time.now + 900;
    this.player.setTint(0xff7777);
    this.cameras.main.shake(100, 0.008);
    SFX.play("hurt");
    this.time.delayedCall(140, () => {
      if (this.player.active) this.player.clearTint();
    });
    this.updateHud();
    if (this.playerStats.hp <= 0) {
      this.loseRun();
    }
  }

  collectPickup(player, pickup) {
    if (pickup.kind === "devilExit") {
      if (this.time.now < this.lastMoveAt + 600) return;
    }
    if (pickup.kind === "heart") {
      if (this.playerStats.hp >= this.playerStats.maxHp) return; // 满血不吃
      this.playerStats.hp = Math.min(this.playerStats.maxHp, this.playerStats.hp + 2); // 治疗 1 整心
      pickup.destroy();
      this.showToast("生命恢复");
      SFX.play("heart");
    } else if (pickup.kind === "soulHeart") {
      this.playerStats.soulHp = Math.min(SOUL_HP_MAX, this.playerStats.soulHp + 2);
      pickup.destroy();
      this.showToast("获得魂心，会优先承受伤害");
      SFX.play("heart");
    } else if (pickup.kind === "coin") {
      this.playerStats.coins += 1;
      pickup.destroy();
      SFX.play("coin");
    } else if (pickup.kind === "key") {
      this.playerStats.keys += 1;
      pickup.destroy();
      this.showToast("获得钥匙");
      SFX.play("key");
    } else if (pickup.kind === "bomb") {
      this.playerStats.bombs += 1;
      pickup.destroy();
      this.showToast("获得炸弹");
      SFX.play("key");
    } else if (pickup.kind === "pill") {
      this.dropHeldItem(this.player.x + 34, this.player.y);
      this.playerStats.heldItem = { kind: "pill", pillId: pickup.pillId };
      pickup.destroy();
      this.showToast("捡到一枚药丸（按 Q 使用，效果未知）");
      SFX.play("key");
    } else if (pickup.kind === "card") {
      const card = CARD_POOL.find((c) => c.id === pickup.cardId);
      this.dropHeldItem(this.player.x + 34, this.player.y);
      this.playerStats.heldItem = { kind: "card", cardId: pickup.cardId };
      pickup.destroy();
      this.showToast(`捡到卡牌「${card ? card.name : "?"}」（按 Q 使用）`);
      SFX.play("key");
    } else if (pickup.kind === "battery") {
      if (!this.playerStats.activeItem) {
        this.showToast("还没有主动道具，电池用不上");
        return;
      }
      if (this.playerStats.activeCharge >= this.playerStats.activeChargeMax) {
        this.showToast("充能已满");
        return;
      }
      this.playerStats.activeCharge = this.playerStats.activeChargeMax;
      pickup.destroy();
      this.showToast("电池让主动道具充能全满");
      SFX.play("item");
    } else if (pickup.kind === "chest") {
      this.openChest(pickup, false);
    } else if (pickup.kind === "goldChest") {
      if (this.playerStats.keys <= 0) {
        if (this.time.now >= (pickup.denyUntil || 0)) {
          pickup.denyUntil = this.time.now + 1000;
          this.showToast("金宝箱需要 1 把钥匙");
        }
        return;
      }
      this.playerStats.keys -= 1;
      this.openChest(pickup, true);
    } else if (pickup.kind === "redChest") {
      // 红箱（原版 Red Chest）：50% 弹 2 颗魂心 / 50% 弹 1 颗炸弹（简化掉 troll 炸弹怪）
      const { x, y } = pickup;
      pickup.destroy();
      SFX.play("unlock");
      this.burst(x, y, 0xb03a3a, 14);
      if (this.rng.frac() < 0.5) {
        this.spawnPickup("soulHeart", x - 18, y - 6);
        this.spawnPickup("soulHeart", x + 18, y - 6);
        this.showToast("红箱里躺着两颗魂心");
      } else {
        this.spawnPickup("bomb", x, y - 8);
        this.showToast("红箱里蹦出一颗炸弹");
      }
    } else if (pickup.kind === "droppedItem") {
      const item = pickup.item;
      pickup.destroy();
      this.applyItem(item);
      this.showBloodBanner(item.name, item.desc, 118);
      SFX.play("item");
      this.flushActiveDrop();
    } else if (pickup.kind === "devilExit") {
      if (!this.exitReady(pickup)) return; // 出口防误触：冷却 + 须先离开过触发区
      this.leaveDevilRoom();
      return;
    } else if (pickup.kind === "devilItem") {
      const deal = pickup.deal;
      if (!deal || deal.taken) return;
      const mode = this.devilDealMode(this.playerStats, deal.cost);
      if (!mode) {
        if (this.time.now >= (pickup.denyUntil || 0)) {
          pickup.denyUntil = this.time.now + 1000;
          this.showToast("心容器和魂心都不够，无法完成交易");
        }
        return;
      }
      this.payDevilDeal(this.playerStats, deal, mode);
      pickup.destroy();
      this.showBloodBanner(deal.name, deal.desc, 118);
      SFX.play("devil");
      this.drawRoom();
    } else if (pickup.kind === "item") {
      this.applyItem(pickup.item);
      pickup.room.itemTaken = true;
      pickup.destroy();
      this.showBloodBanner(pickup.item.name, pickup.item.desc, 118);
      SFX.play("item");
      this.drawRoom();
    } else if (pickup.kind === "shopItem") {
      const slot = pickup.slot;
      if (slot.bought) return;
      if (this.playerStats.coins < slot.price) {
        this.showToast("金币不够");
        return;
      }
      if (slot.kind === "heart" && this.playerStats.hp >= this.playerStats.maxHp) {
        this.showToast("生命已满，不需要买");
        return;
      }
      if (slot.kind === "battery" && !this.playerStats.activeItem) {
        this.showToast("还没有主动道具，电池用不上");
        return;
      }
      this.playerStats.coins -= slot.price;
      slot.bought = true;
      pickup.destroy();
      if (slot.stand) slot.stand.destroy();
      if (slot.saleTag) slot.saleTag.destroy();
      if (slot.label) slot.label.destroy();
      if (slot.kind === "item") {
        this.applyItem(slot.item);
        this.showBloodBanner(slot.item.name, slot.item.desc, 118);
        this.flushActiveDrop();
      } else {
        this.applyShopOffer(slot);
      }
      SFX.play("item");
    }
    this.updateHud();
  }

  // 恶魔交易支付判定（忏悔规则简化）：红心容器够（扣掉 cost×2 半心后仍 ≥1 个整容器）优先扣容器；
  // 容器不够时，魂心 ≥3 颗（6 半心）可纯魂心支付；都不够返回 null（拒付）
  devilDealMode(stats, cost) {
    if (stats.maxHp - cost * 2 >= 2) return "container";
    if (stats.soulHp >= 6) return "soul";
    return null;
  }

  // 恶魔交易结算：按 mode 扣容器或 3 魂心，道具效果落在传入的 stats 上；
  // 主动型交易（如死灵之书）走统一装备结算（旧主动掉回地面，stats.items 由 applyItem 计）
  payDevilDeal(stats, deal, mode) {
    if (mode === "container") {
      stats.maxHp -= deal.cost * 2; // cost 以整心计，换算成半心
      stats.hp = Math.min(stats.hp, stats.maxHp);
    } else if (mode === "soul") {
      stats.soulHp = Math.max(0, stats.soulHp - 6);
    }
    deal.taken = true;
    if (deal.type === "active") this.applyItem(deal);
    else {
      deal.apply(stats);
      this.stats.items += 1;
    }
  }

  // 商店拾取物商品：直接生效
  applyShopOffer(slot) {
    const stats = this.playerStats;
    if (slot.kind === "heart") {
      stats.hp = Math.min(stats.maxHp, stats.hp + 2);
      this.showToast("购买红心：生命恢复");
    } else if (slot.kind === "key") {
      stats.keys += 1;
      this.showToast("购买钥匙");
    } else if (slot.kind === "bomb") {
      stats.bombs += 1;
      this.showToast("购买炸弹");
    } else if (slot.kind === "battery") {
      stats.activeCharge = stats.activeChargeMax;
      this.showToast("购买电池：主动道具充能全满");
    } else if (slot.kind === "pill") {
      this.dropHeldItem(this.player.x + 34, this.player.y);
      stats.heldItem = { kind: "pill", pillId: this.rng.between(0, PILL_EFFECTS.length - 1) };
      this.showToast("购买药丸（按 Q 使用，效果未知）");
    } else if (slot.kind === "card") {
      this.dropHeldItem(this.player.x + 34, this.player.y);
      stats.heldItem = { kind: "card", cardId: this.rng.pick(CARD_POOL).id };
      this.showToast("购买卡牌（按 Q 使用）");
    } else if (slot.kind === "soulHeart") {
      stats.soulHp = Math.min(SOUL_HP_MAX, stats.soulHp + 2);
      this.showToast("购买魂心，会优先承受伤害");
    }
  }

  // 开宝箱：木箱直接开掉零钱/补给，金箱（耗 1 钥匙）出道具或一堆掉落物
  openChest(pickup, golden) {
    const { x, y } = pickup;
    pickup.destroy();
    SFX.play("unlock");
    this.burst(x, y, golden ? 0xd8b23a : 0x8a6238, 14);
    if (golden && this.rng.frac() < 0.55) {
      const passives = ITEM_POOL.filter((item) => item.type === "passive");
      this.spawnDroppedItem(this.pickFromPool(passives), x, y);
      this.showToast("金宝箱里是一件道具！");
      return;
    }
    const drops = golden ? this.rng.between(4, 6) : this.rng.between(2, 4);
    const kinds = golden ? ["coin", "coin", "heart", "key", "bomb", "soulHeart"] : ["coin", "coin", "coin", "heart", "key", "bomb"];
    for (let i = 0; i < drops; i += 1) {
      this.spawnPickup(this.rng.pick(kinds), x + this.rng.between(-52, 52), y + this.rng.between(-30, 30));
    }
    this.showToast(golden ? "金宝箱里滚出一堆补给" : "木箱打开了");
  }

  applyItem(item) {
    if (item.type === "active") {
      if (this.playerStats.activeItem && this.playerStats.activeItem !== item) {
        this.queueActiveDrop(this.playerStats.activeItem);
      }
      this.playerStats.activeItem = item;
      this.playerStats.activeChargeMax = item.chargeMax;
      this.playerStats.activeCharge = item.chargeMax;
    } else {
      item.apply(this.playerStats);
    }
    this.stats.items += 1;
  }

  dropReward() {
    // 清房掉落落在当前房中心（大房为整房外接矩形中心）
    const { cx, cy } = this.curRoomRect();
    if (this.rng.frac() < 0.5 + this.playerStats.rewardLuck) {
      this.spawnPickup("heart", cx - 34, cy);
    }
    const coins = this.rng.between(1, this.rng.frac() < this.playerStats.rewardLuck ? 5 : 3);
    for (let i = 0; i < coins; i += 1) {
      this.spawnPickup("coin", cx + i * 26, cy + 18);
    }
    if (this.rng.frac() < 0.22 + this.playerStats.rewardLuck * 0.5) {
      this.spawnPickup("key", cx - 62, cy + 28);
    }
    if (this.rng.frac() < 0.2 + this.playerStats.rewardLuck * 0.5) {
      this.spawnPickup("bomb", cx + 72, cy + 28);
    }
    if (this.rng.frac() < 0.12 + this.playerStats.rewardLuck * 0.3) {
      this.spawnPickup("soulHeart", cx + 96, cy - 10);
    }
    if (this.rng.frac() < 0.04) {
      this.spawnPickup("pill", cx - 96, cy - 34);
    }
    if (this.rng.frac() < 0.02) {
      this.spawnPickup("card", cx + 96, cy - 34);
    }
    if (this.playerStats.activeItem && this.rng.frac() < 0.045) {
      this.spawnPickup("battery", cx - 34, cy - 52);
    }
    if (this.rng.frac() < 0.05) {
      this.spawnPickup("chest", cx + 150, cy - 60);
    }
    if (this.rng.frac() < 0.03) {
      this.spawnPickup("goldChest", cx - 150, cy - 60);
    }
  }

  pickupTexture(kind) {
    return {
      heart: SPRITES.heart,
      soulHeart: "soulHeart", // 官方蓝魂心贴图（Phase 3 起不再用心形染蓝冒充）
      coin: SPRITES.coin,
      key: SPRITES.key,
      bomb: SPRITES.bomb,
      pill: "pill",
      card: "card",
      battery: "battery",
      chest: "woodChest", // 官方木箱贴图（灰木箱）
      goldChest: "goldChest", // 官方金宝箱贴图（棕箱金锁面）
      redChest: "redChest",
    }[kind] || SPRITES.bomb;
  }

  spawnPickup(kind, x, y, data = {}) {
    const pickup = this.physics.add.sprite(x, y, this.pickupTexture(kind));
    pickup.kind = kind;
    if (kind === "pill") {
      pickup.pillId = data.pillId ?? this.rng.between(0, PILL_EFFECTS.length - 1);
      pickup.setTint(PILL_TINTS[pickup.pillId]);
    }
    if (kind === "card") {
      pickup.cardId = data.cardId ?? this.rng.pick(CARD_POOL).id;
      const card = CARD_POOL.find((c) => c.id === pickup.cardId);
      if (card) pickup.setTint(card.tint);
    }
    const size = kind === "coin" ? 26 : kind === "chest" || kind === "goldChest" || kind === "redChest" ? 46 : kind === "card" || kind === "pill" || kind === "battery" ? 30 : 34;
    this.fitDisplaySize(pickup, size);
    pickup.setDepth(DEPTH.pickup);
    this.pickups.add(pickup);
    // 拾取判定紧贴视觉（约显示尺寸的 0.38），不再用偏大的半贴图圈
    const grab = Math.min(pickup.width, pickup.height) * 0.38;
    pickup.body.setCircle(grab, (pickup.width - grab * 2) / 2, (pickup.height - grab * 2) / 2);
    return pickup;
  }

  tryDoorTransition(time) {
    if (time < this.lastMoveAt + 350) return;
    const room = this.getRoom();
    if (!room.cleared) return;
    const rect = this.curRect || this.roomRect(room);

    // 先判定玩家正跨过哪面墙；越线再看是否踩着某个门槽（大房同墙多槽，就近取槽）
    let crossing = null;
    if (this.player.y < rect.top - 4) crossing = "north";
    else if (this.player.y > rect.bottom + 4) crossing = "south";
    else if (this.player.x < rect.left - 4) crossing = "west";
    else if (this.player.x > rect.right + 4) crossing = "east";
    if (!crossing) {
      this.keepInRoom(this.player);
      return;
    }
    const slot = this.slotForPlayer(room, crossing);
    if (!slot) {
      this.keepInRoom(this.player);
      return;
    }

    // 恶魔门：Boss 房开出的红门（含无真实邻居的幽灵门），走进去直达恶魔房（离屏 9,9）
    if (room.devilDoor === crossing) {
      const behind = this.rooms.get(`${slot.nx},${slot.ny}`);
      if (behind && SECRET_TYPES.has(behind.type) && !behind.revealed) {
        this.keepInRoom(this.player);
        return;
      }
      this.enterDevilRoom();
      return;
    }

    const target = this.rooms.get(`${slot.nx},${slot.ny}`);
    if (!target || (SECRET_TYPES.has(target.type) && !target.revealed)) {
      this.keepInRoom(this.player);
      return;
    }
    if (this.isDoorLocked(target)) {
      if (this.playerStats.keys <= 0) {
        this.showToast("需要钥匙");
        this.keepInRoom(this.player);
        return;
      }
      this.playerStats.keys -= 1;
      target.unlocked = true;
      this.showToast("使用 1 把钥匙开门");
      SFX.play("unlock");
      this.updateHud();
    }

    // 瞬移换房（无滑动过渡）：落在目标房对应槽位内侧，坐标归一到目标房锚点格
    const landing = this.slotLanding(target, slot.nx, slot.ny, crossing);
    this.current = { x: target.x, y: target.y };
    this.player.setPosition(landing.x, landing.y);
    this.lastMoveAt = time;
    this.cameras.main.flash(110, 40, 34, 30);
    SFX.play("door");
    this.drawRoom();
  }

  keepInRoom(sprite) {
    const rect = this.curRect || ROOM;
    // 非玩家（小怪/Boss）：按各自视觉半尺寸夹墙——贴图超出判定圈时外观不得嵌进墙皮
    // （留 4px 咬合量，贴墙看起来是"抵着"而不是"浮着"）
    if (sprite !== this.player) {
      const hw = (sprite.displayWidth || 44) / 2 - 4;
      const hh = (sprite.displayHeight || 44) / 2 - 4;
      if (sprite.x < rect.left + hw) sprite.x = rect.left + hw;
      if (sprite.x > rect.right - hw) sprite.x = rect.right - hw;
      if (sprite.y < rect.top + hh) sprite.y = rect.top + hh;
      if (sprite.y > rect.bottom - hh) sprite.y = rect.bottom - hh;
      return;
    }

    const room = this.getRoom();
    const doorMargin = room.cleared ? 24 : 0;
    // 门槽方向（含无真实邻居的恶魔幽灵门）同样放行过墙，否则永远踩不到触发线；
    // 大房同墙多槽：只有踩着的那条槽巷放行
    const margin = { north: 0, south: 0, west: 0, east: 0 };
    if (doorMargin) {
      const slots = this.curSlots || this.doorSlots(room);
      slots.forEach((slot) => {
        const inLane =
          slot.label === "north" || slot.label === "south"
            ? Math.abs(this.player.x - slot.cx) <= 46
            : Math.abs(this.player.y - slot.cy) <= 46;
        if (!inLane) return;
        const target = this.rooms.get(`${slot.nx},${slot.ny}`);
        const open = (target && (!SECRET_TYPES.has(target.type) || target.revealed)) || room.devilDoor === slot.label;
        if (open) margin[slot.label] = doorMargin;
      });
    }

    // 非门巷方向按"边界 ± 视觉半宽/半高 - 4"夹（玩家显示 52×60，判定圈只 12 半径）：
    // 视觉身体不嵌进墙皮；踩着已开门巷的方向仍按原门宽放行，过门洞触发换房不受影响
    const visHW = 52 / 2 - 4;
    const visHH = 60 / 2 - 4;
    if (sprite.x < rect.left + (margin.west ? -margin.west : visHW)) sprite.x = rect.left + (margin.west ? -margin.west : visHW);
    if (sprite.x > rect.right - (margin.east ? -margin.east : visHW)) sprite.x = rect.right - (margin.east ? -margin.east : visHW);
    if (sprite.y < rect.top + (margin.north ? -margin.north : visHH)) sprite.y = rect.top + (margin.north ? -margin.north : visHH);
    if (sprite.y > rect.bottom - (margin.south ? -margin.south : visHH)) sprite.y = rect.bottom - (margin.south ? -margin.south : visHH);
  }

  enterFloorExit(player, exit) {
    if (!this.exitReady(exit)) return;
    const room = this.getRoom();
    if (room.type !== "boss" || !room.cleared) return;
    this.lastMoveAt = this.time.now;
    this.finishFloor();
  }

  // 出口防误触（恶魔房返回门/楼层活板门）双重保险：
  // a) 换房后 EXIT_GRACE_MS 内不响应重叠；b) 玩家须先离开过触发区（armed），再次进入才触发
  exitReady(exit) {
    return Boolean(exit?.active && exit.armed && this.time.now >= this.lastMoveAt + EXIT_GRACE_MS);
  }

  // armed 标记：玩家不在出口触发区内时才置真——换房瞬间压在出口上不会直接触发，
  // 必须先走出去一次；下次再踩上来才生效
  updateExitArming() {
    const arm = (exit) => {
      if (exit.active && !exit.armed && !this.physics.overlap(this.player, exit)) exit.armed = true;
    };
    this.floorExits.children.each(arm);
    this.pickups.children.each((pickup) => {
      if (pickup.kind === "devilExit") arm(pickup);
    });
  }

  cleanProjectiles() {
    const rect = this.curRect || ROOM;
    this.enemyShots.children.each((shot) => {
      if (shot.x < rect.left - 30 || shot.x > rect.right + 30 || shot.y < rect.top - 30 || shot.y > rect.bottom + 30) {
        shot.destroy();
      }
    });
  }

  burst(x, y, color, amount) {
    for (let i = 0; i < amount; i += 1) {
      const dot = this.add.circle(x, y, this.rng.between(2, 4), color, 0.95);
      dot.setDepth(DEPTH.fx);
      this.tweens.add({
        targets: dot,
        x: x + this.rng.between(-44, 44),
        y: y + this.rng.between(-36, 36),
        alpha: 0,
        scale: 0.2,
        duration: this.rng.between(220, 420),
        onComplete: () => dot.destroy(),
      });
    }
  }

  showToast(text) {
    this.hud.toast.setText(text);
    this.hud.toast.setAlpha(1);
    this.statusTextAt = this.time.now + 2400;
  }

  // 敌人死亡血渍：往合并图层登记一摊不规则暗红团（若干错位椭圆），淡入后常驻到离房
  // 每房最多 60 摊，超出删最旧，避免 graphics 无限膨胀
  spawnBloodDecal(x, y, big = false) {
    if (!this.bloodLayer) return;
    const blobs = [];
    const count = big ? 9 : 5;
    const spread = big ? 52 : 22;
    for (let i = 0; i < count; i += 1) {
      blobs.push({
        dx: this.rng.between(-spread, spread),
        dy: this.rng.between(-spread * 0.6, spread * 0.6),
        rx: this.rng.between(big ? 16 : 7, big ? 34 : 17),
        ry: this.rng.between(big ? 10 : 4, big ? 20 : 9),
        dark: this.rng.frac() < 0.4,
      });
    }
    this.bloodDecals.push({ x, y, blobs, born: this.time.now });
    if (this.bloodDecals.length > 60) this.bloodDecals.shift();
    this.bloodFadeUntil = this.time.now + 320;
    this.redrawBloodLayer(this.time.now);
  }

  redrawBloodLayer(time) {
    if (!this.bloodLayer) return;
    const g = this.bloodLayer;
    g.clear();
    this.bloodDecals.forEach((decal) => {
      const alpha = Math.min(1, Math.max(0, (time - decal.born) / 300)) * 0.78;
      if (alpha <= 0) return;
      decal.blobs.forEach((blob) => {
        g.fillStyle(blob.dark ? 0x420d0d : 0x5e1414, alpha);
        g.fillEllipse(decal.x + blob.dx, decal.y + blob.dy, blob.rx * 2, blob.ry * 2);
      });
    });
  }

  updateHudEffects(time) {
    if (time > this.statusTextAt) {
      this.hud.toast.setAlpha(0);
    }
    // 血渍淡入期间持续重绘合并图层
    if (this.bloodLayer && time < this.bloodFadeUntil) {
      this.redrawBloodLayer(time);
    }
    if (time < this.invulnerableUntil) {
      this.player.setAlpha(Math.sin(time / 45) > 0 ? 0.72 : 1);
    } else {
      this.player.setAlpha(1);
    }
    // 巴比伦娼妇生效时玩家泛红（结算画面保留灰色不再覆盖）
    if (!this.gameEnded) {
      if (this.wobActive) this.player.setTint(0xffb0a8);
      else this.player.clearTint();
    }
  }

  finishFloor() {
    if (this.floor >= MAX_FLOOR) {
      this.winRun();
      return;
    }
    if (this.emperorBoost) {
      // 皇帝卡的临时伤害只持续一层
      this.playerStats.damage = Math.max(0.5, this.playerStats.damage - this.emperorBoost);
      this.emperorBoost = 0;
    }
    this.floor += 1;
    this.rooms = this.buildMap();
    this.current = { x: 0, y: 0 };
    this.activeRoomKey = "0,0";
    this.enteredRooms = new Set(["0,0"]);
    this.clearedRooms = new Set(["0,0"]);
    this.player.setPosition(ROOM.cx, ROOM.cy);
    this.enemyShots.clear(true, true);
    this.tears.clear(true, true);
    this.pickups.clear(true, true);
    this.cameras.main.flash(260, 255, 226, 184);
    SFX.play("clear");
    this.drawRoom();
    this.showBloodBanner(`${this.floorTheme().name} ${FLOOR_ROMAN[this.floor - 1]}`, "2 层起宝箱房与商店需要钥匙");
  }

  winRun() {
    this.gameEnded = true;
    this.player.body.setVelocity(0, 0);
    this.stopPlayerWalk();
    this.showEndCard("你逃出了地窖", "按 R 重新开始");
  }

  loseRun() {
    this.gameEnded = true;
    this.player.body.setVelocity(0, 0);
    this.stopPlayerWalk();
    this.player.setTint(0x333333);
    this.showEndCard("你倒在了地窖里", "按 R 再试一次");
  }

  showEndCard(title, subtitle) {
    const panel = this.add.graphics();
    panel.setDepth(DEPTH.overlay).setScrollFactor(0); // 结算界面钉屏
    panel.fillStyle(0x0b0908, 0.82);
    panel.fillRoundedRect(260, 166, 440, 190, 12);
    panel.lineStyle(2, 0xb99b72, 1);
    panel.strokeRoundedRect(260, 166, 440, 190, 12);
    const h = this.add
      .text(WIDTH / 2, 216, title, {
        fontFamily: "Arial, sans-serif",
        fontSize: "36px",
        color: "#f4efe4",
      })
      .setOrigin(0.5);
    h.setDepth(DEPTH.overlay + 1).setScrollFactor(0);
    const p = this.add
      .text(WIDTH / 2, 278, subtitle, {
        fontFamily: "Arial, sans-serif",
        fontSize: "20px",
        color: "#d8c4a8",
      })
      .setOrigin(0.5);
    p.setDepth(DEPTH.overlay + 1).setScrollFactor(0);
    const seconds = Math.max(0, Math.floor((this.time.now - this.stats.startedAt) / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    const stats = this.add
      .text(
        WIDTH / 2,
        320,
        `层数 ${this.floor}/${MAX_FLOOR}   击杀 ${this.stats.kills}   道具 ${this.stats.items}   清理房间 ${this.clearedRooms.size}   用时 ${mm}:${ss}`,
        {
          fontFamily: "Arial, sans-serif",
          fontSize: "16px",
          color: "#b7a58c",
        },
      )
      .setOrigin(0.5);
    stats.setDepth(DEPTH.overlay + 1).setScrollFactor(0);
  }
}

// 冒烟测试钩子：无头浏览器断言用（不影响游戏逻辑）
window.__TEST__ = {
  ITEM_POOL, DEVIL_POOL, SHOP_OFFERS, HIDDEN_LOOT_TABLE, SUPER_SECRET_LOOT_TABLE,
  ROOM_TEMPLATES, TEMPLATE_KINDS, TEMPLATE_ENEMY_MARKS,
  BOSS_POOLS, BOSS_NAMES, SECRET_TYPES, FLOOR_THEMES, OBSTACLE_TYPES,
};

const config = {
  type: Phaser.CANVAS,
  parent: "game",
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: "#161312",
  pixelArt: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  scene: BasementScene,
};

window.addEventListener("load", () => {
  if (!window.Phaser) {
    document.querySelector("#game").textContent = "Phaser 加载失败，请检查网络后刷新。";
    return;
  }
  window.basementGame = new Phaser.Game(config);
});
