const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const DATA_FILE  = path.join(__dirname, 'data.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');

// ── DATA STORE ──
let db = { users: {}, messages: {}, pushSubs: {} };

function loadData() {
  try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { console.error('Load error:', e.message); }
  if (!db.pushSubs) db.pushSubs = {};
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
  catch(e) { console.error('Save error:', e.message); }
}

loadData();

// ── VAPID KEYS ──
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
}

webpush.setVapidDetails(
  'mailto:snapflow@app.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ── HELPERS ──
function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function chatKey(a, b) { return [a, b].sort().join('::'); }
function sanitizeUser(user) { const { password, ...safe } = user; return safe; }

// ── PUSH HELPER ──
async function sendPush(username, payload) {
  const subs = db.pushSubs[username];
  if (!subs || !subs.length) return;
  const dead = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch(e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint); }
  }
  if (dead.length) { db.pushSubs[username] = subs.filter(s => !dead.includes(s.endpoint)); saveData(); }
}

// ── MIDDLEWARE ──
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ── VAPID KEY ──
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: vapidKeys.publicKey }));

// ── PUSH SUBSCRIBE ──
app.post('/api/push-subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription) return res.json({ error: 'Missing fields.' });
  if (!db.pushSubs[username]) db.pushSubs[username] = [];
  const exists = db.pushSubs[username].some(s => s.endpoint === subscription.endpoint);
  if (!exists) { db.pushSubs[username].push(subscription); saveData(); }
  return res.json({ success: true });
});

// ── AUTH ──
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) return res.json({ error: 'All fields are required.' });
  if (username.length < 3) return res.json({ error: 'Username must be at least 3 characters.' });
  if (password.length < 6) return res.json({ error: 'Password must be at least 6 characters.' });
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (clean !== username.toLowerCase()) return res.json({ error: 'Username can only contain letters, numbers, underscores.' });
  if (db.users[clean]) return res.json({ error: 'Username is already taken.' });
  db.users[clean] = { username: clean, displayName: displayName.trim(), password: sha256(password), friends: [], friendRequests: [], sentRequests: [], createdAt: Date.now() };
  saveData();
  return res.json({ success: true, user: sanitizeUser(db.users[clean]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ error: 'Please enter username and password.' });
  const clean = username.toLowerCase().trim();
  const user = db.users[clean];
  if (!user || user.password !== sha256(password)) return res.json({ error: 'Invalid username or password.' });
  return res.json({ success: true, user: sanitizeUser(user) });
});

app.get('/api/user/:username', (req, res) => {
  const user = db.users[req.params.username.toLowerCase()];
  if (!user) return res.json({ error: 'User not found.' });
  return res.json(sanitizeUser(user));
});

// ── FRIENDS ──
app.post('/api/friend-request', async (req, res) => {
  const { from, to } = req.body;
  const fromUser = db.users[from], toUser = db.users[to];
  if (!fromUser || !toUser) return res.json({ error: 'User not found.' });
  if (from === to) return res.json({ error: "You can't add yourself." });
  if (fromUser.friends.includes(to)) return res.json({ error: 'Already friends.' });
  if (fromUser.sentRequests.includes(to)) return res.json({ error: 'Request already sent.' });

  if (toUser.sentRequests.includes(from)) {
    fromUser.friendRequests = fromUser.friendRequests.filter(r => r !== to);
    toUser.sentRequests = toUser.sentRequests.filter(r => r !== from);
    if (!fromUser.friends.includes(to)) fromUser.friends.push(to);
    if (!toUser.friends.includes(from)) toUser.friends.push(from);
    saveData();
    io.to(to).emit('friend-accepted', { username: from, displayName: fromUser.displayName });
    return res.json({ success: true, autoAccepted: true });
  }

  fromUser.sentRequests.push(to);
  toUser.friendRequests.push(from);
  saveData();
  io.to(to).emit('friend-request', { from, displayName: fromUser.displayName });
  await sendPush(to, { type: 'friend-request', title: '👋 New Friend Request', body: `${fromUser.displayName || from} wants to be friends!`, url: '/' });
  return res.json({ success: true });
});

app.post('/api/friend-accept', async (req, res) => {
  const { username, from } = req.body;
  const user = db.users[username], requester = db.users[from];
  if (!user || !requester) return res.json({ error: 'User not found.' });
  user.friendRequests = user.friendRequests.filter(r => r !== from);
  requester.sentRequests = requester.sentRequests.filter(r => r !== username);
  if (!user.friends.includes(from)) user.friends.push(from);
  if (!requester.friends.includes(username)) requester.friends.push(username);
  saveData();
  io.to(from).emit('friend-accepted', { username, displayName: user.displayName });
  await sendPush(from, { type: 'friend-accepted', title: '✅ Friend Request Accepted', body: `${user.displayName || username} is now your friend!`, url: '/' });
  return res.json({ success: true });
});

app.post('/api/friend-reject', (req, res) => {
  const { username, from } = req.body;
  const user = db.users[username], requester = db.users[from];
  if (!user || !requester) return res.json({ error: 'User not found.' });
  user.friendRequests = user.friendRequests.filter(r => r !== from);
  requester.sentRequests = requester.sentRequests.filter(r => r !== username);
  saveData();
  return res.json({ success: true });
});

app.post('/api/friend-remove', (req, res) => {
  const { username, target } = req.body;
  const user = db.users[username], targetUser = db.users[target];
  if (!user || !targetUser) return res.json({ error: 'User not found.' });
  user.friends = user.friends.filter(f => f !== target);
  targetUser.friends = targetUser.friends.filter(f => f !== username);
  saveData();
  return res.json({ success: true });
});

// ── MESSAGES ──
app.get('/api/messages/:a/:b', (req, res) => {
  return res.json(db.messages[chatKey(req.params.a, req.params.b)] || []);
});

// ── SOCKET.IO ──
const onlineUsers = new Set();

io.on('connection', (socket) => {
  socket.on('authenticate', (username) => {
    socket.username = username;
    socket.join(username);
    onlineUsers.add(username);
    const user = db.users[username];
    if (user) user.friends.forEach(f => io.to(f).emit('user-online', username));
  });

  socket.on('send-message', async ({ from, to, text }) => {
    if (!from || !to || !text || !text.trim()) return;
    const fromUser = db.users[from], toUser = db.users[to];
    if (!fromUser || !toUser || !fromUser.friends.includes(to)) return;

    const key = chatKey(from, to);
    if (!db.messages[key]) db.messages[key] = [];
    const msg = { id: sha256(from + to + Date.now() + Math.random()), from, to, text: text.trim().substring(0, 2000), timestamp: Date.now() };
    db.messages[key].push(msg);
    if (db.messages[key].length > 1000) db.messages[key] = db.messages[key].slice(-1000);
    saveData();

    io.to(from).emit('message', msg);
    io.to(to).emit('message', msg);

    // Push only if recipient is offline
    if (!onlineUsers.has(to)) {
      await sendPush(to, { type: 'message', title: `💬 ${fromUser.displayName || from}`, body: text.trim().substring(0, 100), url: '/', from });
    }
  });

  socket.on('typing',      ({ from, to }) => io.to(to).emit('typing',      { from }));
  socket.on('stop-typing', ({ from, to }) => io.to(to).emit('stop-typing', { from }));

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      const user = db.users[socket.username];
      if (user) user.friends.forEach(f => io.to(f).emit('user-offline', socket.username));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SnapFlow on port ${PORT}`));
