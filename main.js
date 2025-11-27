var DEFAULT_VELOCITY = 0.5;

var Rect = function (x, y, w, h) {
  this.x = x; this.y = y; this.w = w; this.h = h;
  this.x2 = x + w; this.y2 = y + h;
};
Rect.prototype.contains = function (x, y) {
  return x >= this.x && x <= this.x2 && y >= this.y && y <= this.y2;
};


/**
 * MPP.net audio engine
 * mostly unmodified
 */

var AudioEngine = function () { };

AudioEngine.prototype.init = function (cb) {
  this.volume = 0.6;
  this.sounds = {};
  this.paused = true;
  return this;
};

AudioEngine.prototype.load = function (id, url, cb) { };

AudioEngine.prototype.play = function () { };

AudioEngine.prototype.stop = function () { };

AudioEngine.prototype.setVolume = function (vol) {
  this.volume = vol;
};

AudioEngine.prototype.resume = function () {
  this.paused = false;
};

AudioEngineWeb = function () {
  this.threshold = 0;
  this.worker = new Worker("/workerTimer.js");
  var self = this;
  this.worker.onmessage = function (event) {
    if (event.data.args)
      if (event.data.args.action == 0) {
        self.actualPlay(
          event.data.args.id,
          event.data.args.vol,
          event.data.args.time,
          event.data.args.part_id,
        );
      } else {
        self.actualStop(
          event.data.args.id,
          event.data.args.time,
          event.data.args.part_id,
        );
      }
  };
};

AudioEngineWeb.prototype = new AudioEngine();

AudioEngineWeb.prototype.init = function (cb) {
  AudioEngine.prototype.init.call(this);

  this.context = new AudioContext({ latencyHint: "interactive" });

  this.masterGain = this.context.createGain();
  this.masterGain.connect(this.context.destination);
  this.masterGain.gain.value = this.volume;

  this.limiterNode = this.context.createDynamicsCompressor();
  this.limiterNode.threshold.value = -10;
  this.limiterNode.knee.value = 0;
  this.limiterNode.ratio.value = 20;
  this.limiterNode.attack.value = 0;
  this.limiterNode.release.value = 0.1;
  this.limiterNode.connect(this.masterGain);

  this.pianoGain = this.context.createGain();
  this.pianoGain.gain.value = 0.5;
  this.pianoGain.connect(this.limiterNode);
  this.synthGain = this.context.createGain();
  this.synthGain.gain.value = 0.5;
  this.synthGain.connect(this.limiterNode);

  this.playings = {};

  if (cb) setTimeout(cb, 0);
  return this;
};

AudioEngineWeb.prototype.load = function (id, url, cb) {
  var audio = this;
  var req = new XMLHttpRequest();
  req.open("GET", url);
  req.responseType = "arraybuffer";
  req.addEventListener("readystatechange", function (evt) {
    if (req.readyState !== 4) return;
    try {
      audio.context.decodeAudioData(req.response, function (buffer) {
        audio.sounds[id] = buffer;
        if (cb) cb();
      });
    } catch (e) {
      console.log(e)
    }
  });
  req.send();
};

AudioEngineWeb.prototype.actualPlay = function (id, vol, time, part_id) {
  if (this.paused) return;
  if (!this.sounds.hasOwnProperty(id)) return;
  var source = this.context.createBufferSource();
  source.buffer = this.sounds[id];
  var gain = this.context.createGain();
  gain.gain.value = vol;
  source.connect(gain);
  gain.connect(this.pianoGain);
  source.start(time);
  if (this.playings[id]) {
    var playing = this.playings[id];
    playing.gain.gain.setValueAtTime(playing.gain.gain.value, time);
    playing.gain.gain.linearRampToValueAtTime(0.0, time + 0.2);
    playing.source.stop(time + 0.21);
    if (enableSynth && playing.voice) {
      playing.voice.stop(time);
    }
  }
  this.playings[id] = { source: source, gain: gain, part_id: part_id };

  if (enableSynth) {
    this.playings[id].voice = new synthVoice(id, time);
  }
};

AudioEngineWeb.prototype.play = function (id, vol, delay_ms, part_id) {
  if (!this.sounds.hasOwnProperty(id)) return;
  var time = this.context.currentTime + delay_ms / 1000;
  var delay = delay_ms - this.threshold;
  if (delay <= 0) this.actualPlay(id, vol, time, part_id);
  else {
    this.worker.postMessage({
      delay: delay,
      args: {
        action: 0,
        id: id,
        vol: vol,
        time: time,
        part_id: part_id,
      },
    });
  }
};

AudioEngineWeb.prototype.actualStop = function (id, time, part_id) {
  if (
    this.playings.hasOwnProperty(id) &&
    this.playings[id] &&
    this.playings[id].part_id === part_id
  ) {
    var gain = this.playings[id].gain.gain;
    gain.setValueAtTime(gain.value, time);
    gain.linearRampToValueAtTime(gain.value * 0.1, time + 0.16);
    gain.linearRampToValueAtTime(0.0, time + 0.4);
    this.playings[id].source.stop(time + 0.41);

    if (this.playings[id].voice) {
      this.playings[id].voice.stop(time);
    }

    this.playings[id] = null;
  }
};

AudioEngineWeb.prototype.stop = function (id, delay_ms, part_id) {
  var time = this.context.currentTime + delay_ms / 1000;
  var delay = delay_ms - this.threshold;
  if (delay <= 0) this.actualStop(id, time, part_id);
  else {
    this.worker.postMessage({
      delay: delay,
      args: {
        action: 1,
        id: id,
        time: time,
        part_id: part_id,
      },
    });
  }
};

AudioEngineWeb.prototype.setVolume = function (vol) {
  AudioEngine.prototype.setVolume.call(this, vol);
  this.masterGain.gain.value = this.volume;
};

AudioEngineWeb.prototype.resume = function () {
  this.paused = false;
  this.context.resume();
};


/**
 * Renderer:
 * i wrote a key tinting feature that allows
 * for the color of the piano to easily be
 * changed. Work in progress.
 */

var Renderer = function () { };
Renderer.prototype.init = function (piano) {
  this.piano = piano;
  this.resize();
  return this;
};
Renderer.prototype.resize = function (width, height) {
  if (typeof width == "undefined") width = (this.piano.rootElement && $(this.piano.rootElement).width()) || 800;
  if (typeof height == "undefined") height = Math.floor(width * 0.2);
  if (this.piano.rootElement) {
    $(this.piano.rootElement).css({
      height: height + "px",
      marginTop: Math.floor($(window).height() / 2 - height / 2) + "px",
    });
  }
  this.width = width * (window.devicePixelRatio || 1);
  this.height = height * (window.devicePixelRatio || 1);
};
Renderer.prototype.visualize = function (key, color) { };

var CanvasRenderer = function () { Renderer.call(this); };
CanvasRenderer.prototype = new Renderer();

CanvasRenderer.prototype.init = function (piano) {
  this.canvas = document.createElement("canvas");
  this.ctx = this.canvas.getContext("2d");
  piano.rootElement.appendChild(this.canvas);

  Renderer.prototype.init.call(this, piano);

  var self = this;
  var render = function () {
    self.redraw();
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);

  var mouse_down = false;
  var last_key = null;
  $(piano.rootElement).mousedown(function (event) {
    mouse_down = true;
    if (!gNoPreventDefault) event.preventDefault();
    var pos = CanvasRenderer.translateMouseEvent(event);
    var hit = self.getHit(pos.x, pos.y);
    if (hit) {
      press(hit.key.note, hit.v);
      last_key = hit.key;
    }
  });
  piano.rootElement.addEventListener("touchstart", function (event) {
    mouse_down = true;
    if (!gNoPreventDefault) event.preventDefault();
    for (var i in event.changedTouches) {
      var pos = CanvasRenderer.translateMouseEvent(event.changedTouches[i]);
      var hit = self.getHit(pos.x, pos.y);
      if (hit) {
        press(hit.key.note, hit.v);
        last_key = hit.key;
      }
    }
  }, false);
  $(window).mouseup(function () {
    if (last_key) release(last_key.note);
    mouse_down = false;
    last_key = null;
  });

  return this;
};

CanvasRenderer.prototype.resize = function (width, height) {
  Renderer.prototype.resize.call(this, width, height);
  if (this.width < 52 * 2) this.width = 52 * 2;
  if (this.height < this.width * 0.2) this.height = Math.floor(this.width * 0.2);
  this.canvas.width = this.width;
  this.canvas.height = this.height;
  this.canvas.style.width = (this.width / (window.devicePixelRatio || 1)) + "px";
  this.canvas.style.height = (this.height / (window.devicePixelRatio || 1)) + "px";

  this.whiteKeyWidth = Math.floor(this.width / 52);
  this.whiteKeyHeight = Math.floor(this.height * 0.9);
  this.blackKeyWidth = Math.floor(this.whiteKeyWidth * 0.75);
  this.blackKeyHeight = Math.floor(this.height * 0.5);

  this.blackKeyOffset = Math.floor(this.whiteKeyWidth - this.blackKeyWidth / 2);
  this.keyMovement = Math.floor(this.whiteKeyHeight * 0.015);

  this.whiteBlipWidth = Math.floor(this.whiteKeyWidth * 0.7);
  this.whiteBlipHeight = Math.floor(this.whiteBlipWidth * 0.8);
  this.whiteBlipX = Math.floor((this.whiteKeyWidth - this.whiteBlipWidth) / 2);
  this.whiteBlipY = Math.floor(this.whiteKeyHeight - this.whiteBlipHeight * 1.2);
  this.blackBlipWidth = Math.floor(this.blackKeyWidth * 0.7);
  this.blackBlipHeight = Math.floor(this.blackBlipWidth * 0.8);
  this.blackBlipY = Math.floor(this.blackKeyHeight - this.blackBlipHeight * 1.2);
  this.blackBlipX = Math.floor((this.blackKeyWidth - this.blackBlipWidth) / 2);

  //this.keyTint = "#ff0000";

  // Source - https://stackoverflow.com/a/5092846  Posted by DanS,
  this.keyTint = '#'+(Math.random() * 0xFFFFFF << 0).toString(16).padStart(6, '0');

  window.keyTint = this.keyTint;

  function hexToRgb(hex) {
    var shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    hex = hex.replace(shorthandRegex, function (m, r, g, b) {
      return r + r + g + g + b + b;
    });
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  function adjustColor(hex, percent) {
    var f = hexToRgb(hex);
    if (!f) return hex;
    var R = f.r, G = f.g, B = f.b;
    var t = (R + G + B) / 3;

    var R_new = Math.min(255, Math.max(0, R + percent * 2.55));
    var G_new = Math.min(255, Math.max(0, G + percent * 2.55));
    var B_new = Math.min(255, Math.max(0, B + percent * 2.55));

    var toHex = function (c) {
      var hex = Math.floor(c).toString(16);
      return hex.length == 1 ? "0" + hex : hex;
    };

    return "#" + toHex(R_new) + toHex(G_new) + toHex(B_new);
    Renderer.prototype.resize.call(this, width, height);
  }
  window.adjustColor = adjustColor;
  this.whiteKeyRender = document.createElement("canvas");
  this.whiteKeyRender.width = this.whiteKeyWidth;
  this.whiteKeyRender.height = this.height + 10;
  var ctx = this.whiteKeyRender.getContext("2d");

  var tintLight = keyTint;
  var tintMid = adjustColor(keyTint, -10);
  var tintDark = adjustColor(keyTint, -20);

  if (ctx.createLinearGradient) {
    var gradient = ctx.createLinearGradient(0, 0, 0, this.whiteKeyHeight);
    gradient.addColorStop(0, tintMid);
    gradient.addColorStop(0.75, tintLight);
    gradient.addColorStop(1, tintDark);
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = tintLight;

  ctx.strokeStyle = "#000"; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.lineWidth = 10;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, this.whiteKeyWidth - ctx.lineWidth, this.whiteKeyHeight - ctx.lineWidth);
  ctx.lineWidth = 4;
  ctx.fillRect(ctx.lineWidth / 2, ctx.lineWidth / 2, this.whiteKeyWidth - ctx.lineWidth, this.whiteKeyHeight - ctx.lineWidth);

  this.blackKeyRender = document.createElement("canvas");
  this.blackKeyRender.width = this.blackKeyWidth + 10;
  this.blackKeyRender.height = this.blackKeyHeight + 10;
  var ctx = this.blackKeyRender.getContext("2d");

  var blackBaseColor = adjustColor(keyTint, -95);
  var blackHighlight = adjustColor(keyTint, -80);
  var blackStrokeColor = adjustColor(keyTint, -90);

  if (ctx.createLinearGradient) {
    var gradient = ctx.createLinearGradient(0, 0, 0, this.blackKeyHeight);

    gradient.addColorStop(0, blackBaseColor);
    gradient.addColorStop(1, blackHighlight);
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = blackBaseColor;

  ctx.strokeStyle = blackStrokeColor;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.lineWidth = 8;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, this.blackKeyWidth - ctx.lineWidth, this.blackKeyHeight - ctx.lineWidth);
  ctx.lineWidth = 4;
  ctx.fillRect(ctx.lineWidth / 2, ctx.lineWidth / 2, this.blackKeyWidth - ctx.lineWidth, this.blackKeyHeight - ctx.lineWidth);
  this.shadowRender = [];
  var y = -this.canvas.height * 2;
  for (var j = 0; j < 2; j++) {
    var canvas = document.createElement("canvas"); this.shadowRender[j] = canvas;
    canvas.width = this.canvas.width; canvas.height = this.canvas.height;
    var ctx = canvas.getContext("2d");
    var sharp = j ? true : false;
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.lineWidth = 1;
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)"; ctx.shadowBlur = this.keyMovement * 3;
    ctx.shadowOffsetY = -y + this.keyMovement;
    if (sharp) { ctx.shadowOffsetX = this.keyMovement; } else { ctx.shadowOffsetX = 0; ctx.shadowOffsetY = -y + this.keyMovement; }
    for (var i in this.piano.keys) {
      if (!this.piano.keys.hasOwnProperty(i)) continue;
      var key = this.piano.keys[i];
      if (key.sharp != sharp) continue;
      if (key.sharp) {
        ctx.fillRect(this.blackKeyOffset + this.whiteKeyWidth * key.spatial + ctx.lineWidth / 2, y + ctx.lineWidth / 2, this.blackKeyWidth - ctx.lineWidth, this.blackKeyHeight - ctx.lineWidth);
      } else {
        ctx.fillRect(this.whiteKeyWidth * key.spatial + ctx.lineWidth / 2, y + ctx.lineWidth / 2, this.whiteKeyWidth - ctx.lineWidth, this.whiteKeyHeight - ctx.lineWidth);
      }
    }
  }

  for (var i in this.piano.keys) {
    if (!this.piano.keys.hasOwnProperty(i)) continue;
    var key = this.piano.keys[i];
    if (key.sharp) {
      key.rect = new Rect(this.blackKeyOffset + this.whiteKeyWidth * key.spatial, 0, this.blackKeyWidth, this.blackKeyHeight);
    } else {
      key.rect = new Rect(this.whiteKeyWidth * key.spatial, 0, this.whiteKeyWidth, this.whiteKeyHeight);
    }
  }
};

CanvasRenderer.prototype.visualize = function (key, color) {
  key.timePlayed = Date.now();
  key.blips.push({ time: key.timePlayed, color: color });
};

CanvasRenderer.prototype.redraw = function () {
  var now = Date.now();
  var timeLoadedEnd = now - 1000;
  var timePlayedEnd = now - 100;
  var timeBlipEnd = now - 1000;

  this.ctx.save();
  this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

  for (var j = 0; j < 2; j++) {
    this.ctx.globalAlpha = 1.0;
    this.ctx.drawImage(this.shadowRender[j], 0, 0);
    var sharp = j ? true : false;
    for (var i in this.piano.keys) {
      if (!this.piano.keys.hasOwnProperty(i)) continue;
      var key = this.piano.keys[i];
      if (key.sharp != sharp) continue;

      // Calculate the themed blip color once for this key iteration
      var blipColor = adjustColor(this.keyTint, -50);

      if (!key.loaded) {
        this.ctx.globalAlpha = 0.2;
      } else if (key.timeLoaded > timeLoadedEnd) {
        this.ctx.globalAlpha = ((now - key.timeLoaded) / 1000) * 0.8 + 0.2;
      } else {
        this.ctx.globalAlpha = 1.0;
      }
      var y = 0;
      if (key.timePlayed > timePlayedEnd) {
        y = Math.floor(this.keyMovement - ((now - key.timePlayed) / 100) * this.keyMovement);
      }
      var x = Math.floor(key.sharp ? this.blackKeyOffset + this.whiteKeyWidth * key.spatial : this.whiteKeyWidth * key.spatial);
      var image = key.sharp ? this.blackKeyRender : this.whiteKeyRender;
      this.ctx.drawImage(image, x, y);


      if (key.blips.length) {
        var alpha = this.ctx.globalAlpha;
        var w, h;
        if (key.sharp) {
          x += this.blackBlipX;
          y = this.blackBlipY;
          w = this.blackBlipWidth;
          h = this.blackBlipHeight;
        } else {
          x += this.whiteBlipX;
          y = this.whiteBlipY;
          w = this.whiteBlipWidth;
          h = this.whiteBlipHeight;
        }
        for (var b = 0; b < key.blips.length; b++) {
          var blip = key.blips[b];
          if (blip.time > timeBlipEnd) {
            this.ctx.fillStyle = blipColor; // REPLACED HARDCODED COLOR
            this.ctx.globalAlpha = alpha - ((now - blip.time) / 1000) * alpha;
            this.ctx.fillRect(x, y, w, h);
          } else {
            key.blips.splice(b, 1); --b;
          }
          y -= Math.floor(h * 1.1);
        }
      }
    }
  }


  this.ctx.restore();
};

CanvasRenderer.prototype.getHit = function (x, y) {
  for (var j = 0; j < 2; j++) {
    var sharp = j ? false : true;
    for (var i in this.piano.keys) {
      if (!this.piano.keys.hasOwnProperty(i)) continue;
      var key = this.piano.keys[i];
      if (key.sharp != sharp) continue;
      if (key.rect.contains(x, y)) {
        var v = y / (key.sharp ? this.blackKeyHeight : this.whiteKeyHeight);
        v += 0.25; v *= DEFAULT_VELOCITY;
        if (v > 1.0) v = 1.0;
        return { key: key, v: v };
      }
    }
  }
  return null;
};

CanvasRenderer.isSupported = function () {
  var canvas = document.createElement("canvas");
  return !!(canvas.getContext && canvas.getContext("2d"));
};

CanvasRenderer.translateMouseEvent = function (evt) {
  var element = evt.target;
  var offx = 0; var offy = 0;
  do {
    if (!element) break;
    offx += element.offsetLeft;
    offy += element.offsetTop;
  } while ((element = element.offsetParent));
  return { x: (evt.pageX - offx) * (window.devicePixelRatio || 1), y: (evt.pageY - offy) * (window.devicePixelRatio || 1) };
};

if (window.location.hostname === "localhost") var soundDomain = `http://${location.host}`;
else var soundDomain = "https://multiplayerpiano.net";

function SoundSelector(piano) {
  this.initialized = false;
  this.keys = piano.keys;
  this.loading = {};
  this.packs = [];
  this.piano = piano;
  this.soundSelection = localStorage.soundSelection ? localStorage.soundSelection : "mppclassic";
  this.addPack({ name: "MPP Classic", keys: Object.keys(this.piano.keys), ext: ".mp3", url: "/sounds/mppclassic/" });
}
SoundSelector.prototype.addPack = function (pack, load) {
  var self = this;
  self.loading[pack.url || pack] = true;
  function add(obj) {
    var added = false;
    for (var i = 0; self.packs.length > i; i++) {
      if (obj.name == self.packs[i].name) { added = true; break; }
    }
    if (added) return console.warn("Sounds already added!!");
    if (obj.url.substr(obj.url.length - 1) != "/") obj.url = obj.url + "/";
    var html = document.createElement("li");
    html.classList = "pack";
    html.innerText = obj.name + " (" + obj.keys.length + " keys)";
    html.onclick = function () { self.loadPack(obj.name); };
    obj.html = html;
    self.packs.push(obj);
    self.packs.sort(function (a, b) { if (a.name < b.name) return -1; if (a.name > b.name) return 1; return 0; });
    if (load) self.loadPack(obj.name);
    delete self.loading[obj.url];
  }
  add(pack);
};

/**
 * Sound selector:
 * mostly unchanged from MPP.net, besides
 * the lack of local sound files
 */

SoundSelector.prototype.addPacks = function (packs) {
  for (var i = 0; packs.length > i; i++) this.addPack(packs[i]);
};
SoundSelector.prototype.init = function () {
  var self = this;
  if (self.initialized) return console.warn("Sound selector already initialized!");
  if (!!Object.keys(self.loading).length) return setTimeout(function () { self.init(); }, 250);
  self.initialized = true;
  self.loadPack(self.soundSelection, true);
};
SoundSelector.prototype.loadPack = function (pack, f) {
  for (var i = 0; this.packs.length > i; i++) { if (this.packs[i].name == pack) { pack = this.packs[i]; break; } }
  if (typeof pack == "string") return this.loadPack("MPP Classic");
  if (pack.name == this.soundSelection && !f) return;
  if (pack.keys.length != Object.keys(this.piano.keys).length) {
    this.piano.keys = {};
    for (var i = 0; pack.keys.length > i; i++) this.piano.keys[pack.keys[i]] = this.keys[pack.keys[i]];
    this.piano.renderer.resize();
  }
  var self = this;
  for (var i in this.piano.keys) {
    if (!this.piano.keys.hasOwnProperty(i)) continue;
    (function () {
      var key = self.piano.keys[i];
      key.loaded = false;
      let useDomain = true;
      if (pack.url.match(/^(http|https):\/\//i)) useDomain = false;
      self.piano.audio.load(key.note, (useDomain ? soundDomain : "") + pack.url + key.note + pack.ext, function () {
        key.loaded = true; key.timeLoaded = Date.now();
      });
    })();
  }
  if (localStorage) localStorage.soundSelection = pack.name;
  this.soundSelection = pack.name;
};

var PianoKey = function (note, octave) {
  this.note = note + octave;
  this.baseNote = note;
  this.octave = octave;
  this.sharp = note.indexOf("s") != -1;
  this.loaded = false;
  this.timeLoaded = 0;
  this.timePlayed = 0;
  this.blips = [];
};

var Piano = function (rootElement) {
  var piano = this;
  piano.rootElement = rootElement;
  piano.keys = {};

  var white_spatial = 0;
  var black_spatial = 0;
  var black_it = 0;
  var black_lut = [2, 1, 2, 1, 1];
  var addKey = function (note, octave) {
    var key = new PianoKey(note, octave);
    piano.keys[key.note] = key;
    if (key.sharp) {
      key.spatial = black_spatial;
      black_spatial += black_lut[black_it % 5];
      ++black_it;
    } else {
      key.spatial = white_spatial; ++white_spatial;
    }
  };

  var test_mode = window.location.hash && window.location.hash.match(/^(?:#.+)*#test(?:#.+)*$/i);
  if (test_mode) {
    addKey("c", 2);
  } else {
    addKey("a", -1); addKey("as", -1); addKey("b", -1);
    var notes = "c cs d ds e f fs g gs a as b".split(" ");
    for (var oct = 0; oct < 7; oct++) {
      for (var i in notes) addKey(notes[i], oct);
    }
    addKey("c", 7);
  }

  this.renderer = new CanvasRenderer().init(this);
  window.addEventListener("resize", function () { piano.renderer.resize(); });

  var audio_engine = AudioEngineWeb;
  this.audio = new audio_engine().init();
};

Piano.prototype.play = function (note, vol, participant, delay_ms) {
  if (!this.keys.hasOwnProperty(note) || !participant) return;
  var key = this.keys[note];
  if (key.loaded) this.audio.play(key.note, vol, delay_ms, participant.id);
  var self = this;
  setTimeout(function () {
    self.renderer.visualize(key, participant.color);
  }, delay_ms || 0);
};

Piano.prototype.stop = function (note, participant, delay_ms) {
  if (!this.keys.hasOwnProperty(note) || !participant) return;
  var key = this.keys[note];
  if (key.loaded) this.audio.stop(key.note, delay_ms, participant.id);
};

var gNoteQuota = { spend: function (n) { return true; } };

var localParticipant = {
  id: "local",
  color: localStorage.color || "#ecfaed",
};

var gNoPreventDefault = false;
var gHighlightScaleNotes = "";

var pianoRoot = document.getElementById("piano");
if (!pianoRoot) {
  pianoRoot = document.createElement("div");
  pianoRoot.id = "piano";
  document.body.appendChild(pianoRoot);
}
var gPiano = new Piano(pianoRoot);

var gSoundSelector = new SoundSelector(gPiano);

/** not really planning on using this for the web app...
gSoundSelector.addPacks([
  {
    name: "Emotional",
    keys: Object.keys(gPiano.keys),
    ext: ".mp3",
    url: "/sounds/Emotional/"
  }
]);*/
gSoundSelector.init();
//gSoundSelector.loadPack('MPP Classic', true);

var gAutoSustain = false;
var gSustain = false;
var gHeldNotes = {};
var gSustainedNotes = {};

function press(id, vol) {
  if (gNoteQuota.spend(1)) {
    gHeldNotes[id] = true;
    gSustainedNotes[id] = true;
    gPiano.play(id, vol !== undefined ? vol : DEFAULT_VELOCITY, localParticipant, 0);
  }
}

function release(id) {
  if (gHeldNotes[id]) {
    gHeldNotes[id] = false;
    if ((gAutoSustain || gSustain) && !enableSynth) {
      gSustainedNotes[id] = true;
    } else {
      if (gNoteQuota.spend(1)) {
        gPiano.stop(id, localParticipant, 0);
        gSustainedNotes[id] = false;
      }
    }
  }
}

function pressSustain() { gSustain = true; }
function releaseSustain() {
  gSustain = false;
  if (!gAutoSustain) {
    for (var id in gSustainedNotes) {
      if (gSustainedNotes.hasOwnProperty(id) && gSustainedNotes[id] && !gHeldNotes[id]) {
        gSustainedNotes[id] = false;
        if (gNoteQuota.spend(1)) gPiano.stop(id, localParticipant, 0);
      }
    }
  }
}

var MIDI_TRANSPOSE = -12;
var MIDI_KEY_NAMES = ["a-1", "as-1", "b-1"];
var bare_notes = "c cs d ds e f fs g gs a as b".split(" ");
for (var oct = 0; oct < 7; oct++) {
  for (var i in bare_notes) MIDI_KEY_NAMES.push(bare_notes[i] + oct);
}
MIDI_KEY_NAMES.push("c7");

if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(function (midi) {
    function midimessagehandler(evt) {
      var cmd = evt.data[0] >> 4;
      var note_number = evt.data[1];
      var vel = evt.data[2];
      if (cmd == 8 || (cmd == 9 && vel == 0)) {
        release(MIDI_KEY_NAMES[note_number - 9 + MIDI_TRANSPOSE]);
      } else if (cmd == 9) {
        var noteName = MIDI_KEY_NAMES[note_number - 9 + MIDI_TRANSPOSE];
        press(noteName, (vel / 127) * DEFAULT_VELOCITY);
      }
    }
    var inputs = midi.inputs.values();
    for (var input = inputs.next(); input && !input.done; input = inputs.next()) {
      input.value.onmidimessage = midimessagehandler;
      input.value.enabled = true;
      input.value.volume = 1.0;
    }
    midi.onstatechange = function (e) {
      var inputs = midi.inputs.values();
      for (var input = inputs.next(); input && !input.done; input = inputs.next()) {
        input.value.onmidimessage = midimessagehandler;
        input.value.enabled = true;
      }
    };
  });
}


var enableSynth = false;
var audio = gPiano.audio;
var context = gPiano.audio.context;
//var synth_gain = context.createGain();
//synth_gain.gain.value = 0.05;
//synth_gain.connect(audio.synthGain);
/** 
var osc1_type = "square";
var osc1_attack = 0;
var osc1_decay = 0.2;
var osc1_sustain = 0.5;
var osc1_release = 2.0;
*/

function synthVoice(note_name, time) {
  var note_number = (function () {
    return MIDI_KEY_NAMES.indexOf(note_name);
  })();
  var freq = Math.pow(2, (note_number - 69) / 12) * 440.0;
  this.osc = context.createOscillator();
  this.osc.type = osc1_type;
  this.osc.frequency.value = freq;
  this.gain = context.createGain();
  this.gain.gain.value = 0;
  this.osc.connect(this.gain);
  this.gain.connect(synth_gain);
  this.osc.start(time);
  this.gain.gain.setValueAtTime(0, time);
  this.gain.gain.linearRampToValueAtTime(1, time + osc1_attack);
  this.gain.gain.linearRampToValueAtTime(osc1_sustain, time + osc1_attack + osc1_decay);
}
synthVoice.prototype.stop = function (time) {
  this.gain.gain.linearRampToValueAtTime(0, time + osc1_release);
  this.osc.stop(time + osc1_release);
};


window.MPP = {
  press: press,
  release: release,
  pressSustain: pressSustain,
  releaseSustain: releaseSustain,
  piano: gPiano,
  soundSelector: gSoundSelector,
};

document.body.addEventListener("click", function initAudio() {
  gPiano.audio.resume();
  document.body.removeEventListener("click", initAudio);
  console.log("intiailziated"); 
});


// Credit: hri7566
function hslToRgb(h, s, l) {
  var r, g, b;

  if (s == 0) {
    r = g = b = l;
  } else {
    var hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }

    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
window.hslToRgb = hslToRgb;

// Credit: some stackoverflow post
function rgbToHex(r, g, b) {
  const toHex = (c) => {
    const hex = c.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
window.rgbToHex = rgbToHex;
