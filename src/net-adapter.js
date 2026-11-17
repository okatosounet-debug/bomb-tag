/* Online play outside claude.ai: the same small "room" API the game uses, built on
   Supabase Realtime (finding each other, starting a connection) + WebRTC data channels
   (the match traffic itself, player to player, so it does not count against Supabase). */
(() => {
  if (window.claude) return;
  const CFG = window.BT_SUPA;
  if (!CFG || !CFG.url || !CFG.key || !window.supabase) return;
  const sb = window.supabase.createClient(CFG.url, CFG.key, { realtime: { params: { eventsPerSecond: 40 } } });
  window.__btSb = sb;   // the game's weekly leaderboard uses the same connection
  const ME = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
  const rooms = new Map();
  const stats = { sbSent: 0, dcSent: 0, dcOpen: 0, fallback: 0 };
  window.__btNet = { ME, stats, rooms };

  function mkRoom(name, lobby) {
    const ch = sb.channel('bt-' + name, { config: { broadcast: { self: false, ack: false } } });
    let pres = {}, v = 0, left = false, conn = false, snap = Object.freeze([]);
    const listeners = new Set(), connL = new Set();
    // voice: one audio line per player, set up with the connection; the mic is switched in and out without re-connecting
    let mic = null; const voiceOk = new Map(), audioL = new Set();
    const sendVoice = (p, o) => { if (o && o.tx) o.tx.sender.replaceTrack(mic && voiceOk.get(p) !== false ? mic : null).catch(() => {}); };
    const gotTrack = (p, e) => {
      if (e.track.kind !== 'audio') return;
      const st = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      for (const f of audioL) try { f(p, st); } catch (er) {}
    };
    const others = new Map();       // peer -> { presence, v, t, seen, pc, dc, dcOk, made, fb }
    const EXPIRE = lobby ? 9000 : 6000;
    const rebuild = () => {
      const arr = [Object.freeze({ peer: ME, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: Object.freeze({ ...pres }), updatedAt: Date.now() })];
      for (const [p, o] of others) if (o.presence) arr.push(Object.freeze({ peer: p, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: o.presence, updatedAt: o.t }));
      snap = Object.freeze(arr);
      const ch2 = { peers: snap, joined: [], left: [], updated: [] };
      for (const f of listeners) try { f(ch2); } catch (e) {}
    };
    const sbSend = (m) => { if (left) return; stats.sbSent++; ch.send({ type: 'broadcast', event: 'm', payload: m }).catch(() => {}); };
    const peer = (p) => { let o = others.get(p); if (!o) { o = { presence: null, v: -1, t: 0, seen: Date.now(), firstSeen: Date.now() }; others.set(p, o); } return o; };
    const gotPres = (p, pv, pr) => {
      const o = peer(p); o.seen = Date.now();
      if (pr && pv !== o.v) { o.v = pv; o.presence = Object.freeze(pr); o.t = Date.now(); rebuild(); }
    };
    const dropPeer = (p) => {
      const o = others.get(p); if (!o) return;
      for (const f of audioL) try { f(p, null); } catch (er) {}
      try { if (o.dc) o.dc.close(); } catch (e) {}
      try { if (o.pc) o.pc.close(); } catch (e) {}
      others.delete(p); rebuild();
    };
    // ---- WebRTC (match rooms only) ----
    function wireDC(p, o, dc) {
      o.dc = dc;
      dc.onopen = () => { o.dcOk = true; stats.dcOpen++; try { dc.send(JSON.stringify({ t: 'p', v, pr: pres })); } catch (e) {} };
      dc.onclose = () => { o.dcOk = false; };
      dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (er) { return; }
        if (m.t === 'p') gotPres(p, m.v, m.pr);
        else if (m.t === 'hb') { const q = others.get(p); if (q) q.seen = Date.now(); }
        else if (m.t === 'bye') dropPeer(p);
      };
    }
    function waitIce(pc) {
      return new Promise(res => {
        if (pc.iceGatheringState === 'complete') return res();
        const t = setTimeout(res, 2500);
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
      });
    }
    async function connectTo(p) {
      const o = peer(p);
      if (o.made || lobby || left) return;
      o.made = true;
      try {
        const pc = new RTCPeerConnection(ICE); o.pc = pc;
        wireDC(p, o, pc.createDataChannel('g', { ordered: false, maxRetransmits: 0 }));
        try { o.tx = pc.addTransceiver('audio', { direction: 'sendrecv' }); pc.ontrack = (e) => gotTrack(p, e); sendVoice(p, o); } catch (e) {}
        await pc.setLocalDescription(await pc.createOffer());
        await waitIce(pc);
        sbSend({ t: 'sig', p: ME, to: p, d: { type: 'offer', sdp: pc.localDescription.sdp } });
      } catch (e) {}
    }
    async function onSig(from, d) {
      if (lobby || left) return;
      const o = peer(from);
      try {
        if (d.type === 'offer') {
          if (o.pc) { try { o.pc.close(); } catch (e) {} }
          const pc = new RTCPeerConnection(ICE); o.pc = pc; o.made = true;
          pc.ondatachannel = (e) => wireDC(from, o, e.channel);
          pc.ontrack = (e) => gotTrack(from, e);
          await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
          try { const t = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio'); if (t) { t.direction = 'sendrecv'; o.tx = t; sendVoice(from, o); } } catch (e) {}
          await pc.setLocalDescription(await pc.createAnswer());
          await waitIce(pc);
          sbSend({ t: 'sig', p: ME, to: from, d: { type: 'answer', sdp: pc.localDescription.sdp } });
        } else if (d.type === 'answer' && o.pc && o.pc.signalingState === 'have-local-offer') {
          await o.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        }
      } catch (e) {}
    }
    const discovered = (p) => { if (!lobby && ME < p) connectTo(p); };
    // ---- signalling channel ----
    ch.on('broadcast', { event: 'm' }, ({ payload: m }) => {
      if (left || !m || typeof m.p !== 'string' || m.p === ME) return;
      if (m.to && m.to !== ME) return;
      if (m.t === 'bye') { dropPeer(m.p); return; }
      if (m.t === 'sig') { onSig(m.p, m.d || {}); return; }
      const isNew = !others.has(m.p);
      if (m.t === 'p') gotPres(m.p, m.v, m.pr); else peer(m.p).seen = Date.now();
      if (isNew) discovered(m.p);
      if (m.t === 'hi') sendSb(true);
    });
    ch.subscribe((st) => {
      const c = st === 'SUBSCRIBED';
      if (c !== conn) { conn = c; for (const f of connL) try { f(c); } catch (e) {} }
      if (c) sbSend({ t: 'hi', p: ME, v, pr: pres });
    });
    // presence over Supabase: always in the lobby (rarely changes); in a match only while
    // someone cannot be reached directly, and then only a few times a second
    let lastSb = 0, sbTimer = null;
    function needSb() {
      if (lobby) return true;
      const now = Date.now();
      for (const o of others.values()) if (!o.dcOk && now - o.firstSeen > 2500) { if (!o.fb) { o.fb = true; stats.fallback++; } return true; }
      return false;
    }
    function sendSb(force) {
      const gap = lobby ? 400 : 220;
      const now = Date.now();
      if (!force && now - lastSb < gap) { if (!sbTimer) sbTimer = setTimeout(() => { sbTimer = null; sendSb(true); }, gap - (now - lastSb)); return; }
      lastSb = now; sbSend({ t: 'p', p: ME, v, pr: pres });
    }
    let dcPending = false;
    function flush() {
      dcPending = false;
      const msg = JSON.stringify({ t: 'p', v, pr: pres });
      for (const o of others.values()) if (o.dcOk) { try { o.dc.send(msg); stats.dcSent++; } catch (e) {} }
      if (needSb()) sendSb(false);
    }
    const hb = setInterval(() => {
      if (left) return;
      const now = Date.now();
      // keep-alive: lobby every 3 s over Supabase, match rooms over the direct link
      if (lobby) { if (now - lastSb > 3000) sendSb(true); }
      else {
        for (const o of others.values()) if (o.dcOk) { try { o.dc.send('{"t":"hb"}'); } catch (e) {} }
        if (needSb() && now - lastSb > 1000) sendSb(true);
        if (!others.size && now - lastSb > 2500) sbSend({ t: 'hi', p: ME });
      }
      let gone = false;
      for (const [p, o] of others) if (now - o.seen > EXPIRE) { dropPeer(p); gone = true; }
      if (!gone && snap.length !== others.size + 1) rebuild();
    }, 1000);
    rebuild();
    const R = {
      name,
      presence(patch) {
        if (left) return Promise.reject({ code: 'invalid_argument' });
        for (const k in patch) { if (patch[k] === null) delete pres[k]; else pres[k] = patch[k]; }
        pres = JSON.parse(JSON.stringify(pres)); v++;
        rebuild();
        if (!dcPending) { dcPending = true; setTimeout(flush, 33); }
        return Promise.resolve();
      },
      peers() { return snap; },
      // voice chat (match rooms on this site only)
      voice: lobby ? undefined : {
        setMic(track) { mic = track || null; for (const [p, o] of others) sendVoice(p, o); },
        sendTo(p, ok) { if (voiceOk.get(p) === ok) return; voiceOk.set(p, ok); sendVoice(p, others.get(p)); },
        onAudio(f) { audioL.add(f); return () => audioL.delete(f); }
      },
      onPeers(f) { listeners.add(f); setTimeout(() => f({ peers: snap, joined: snap, left: [], updated: [] }), 0); return () => listeners.delete(f); },
      emit() { return Promise.resolve(); }, on() { return () => {}; },
      connected() { return conn; },
      onConnection(f) { connL.add(f); setTimeout(() => f(conn), 0); return () => connL.delete(f); },
      join(n) {
        if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(n)) return Promise.reject({ code: 'invalid_argument' });
        if (rooms.has(n)) return Promise.resolve(rooms.get(n));
        const r = mkRoom(n, n[0] === 'f'); rooms.set(n, r);   // friends' lobbies: Supabase only; match rooms: direct links
        return new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (r.connected() || Date.now() - t0 > 6000) { clearInterval(iv); res(r); } }, 60); });
      },
      leave() {
        if (left) return Promise.resolve();
        const bye = JSON.stringify({ t: 'bye' });
        for (const o of others.values()) if (o.dcOk) { try { o.dc.send(bye); } catch (e) {} }
        sbSend({ t: 'bye', p: ME });
        left = true; clearInterval(hb);
        for (const p of [...others.keys()]) dropPeer(p);
        rooms.delete(name);
        setTimeout(() => { try { sb.removeChannel(ch); } catch (e) {} }, 300);
        return Promise.resolve();
      }
    };
    return R;
  }
  let lobbyRoom = null;
  window.claude = {
    use: (n) => new Promise(res => {
      if (n !== 'room') return res(null);
      if (!lobbyRoom) { lobbyRoom = mkRoom('lobby', true); rooms.set('__lobby', lobbyRoom); }
      const t0 = Date.now();
      const iv = setInterval(() => { if (lobbyRoom.connected() || Date.now() - t0 > 8000) { clearInterval(iv); res(lobbyRoom.connected() ? lobbyRoom : null); } }, 80);
    })
  };
  addEventListener('pagehide', () => { for (const r of [...rooms.values()]) r.leave(); });
})();
