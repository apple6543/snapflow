const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const DATA_FILE = path.join(__dirname, 'data.json');

// ── DATA STORE ──
let db = { users: {}, messages: {} };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load data:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db), 'utf8');
  } catch (e) {
    console.error('Failed to save data:', e.message);
  }
}

loadData();

// ── HELPERS ──
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function chatKey(a, b) {
  return [a, b].sort().join('::');
}

function sanitizeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

// ── MIDDLEWARE ──
app.use(express.json());
app.use(express.static(path.join(__dirname));

// ── AUTH ROUTES ──
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    return res.json({ error: 'All fields are required.' });
  }
  if (username.length < 3) {
    return res.json({ error: 'Username must be at least 3 characters.' });
  }
  if (password.length < 6) {
    return res.json({ error: 'Password must be at least 6 characters.' });
  }
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (clean !== username.toLowerCase()) {
    return res.json({ error: 'Username can only contain letters, numbers, underscores.' });
  }
  if (db.users[clean]) {
    return res.json({ error: 'Username is already taken.' });
  }

  db.users[clean] = {
    username: clean,
    displayName: displayName.trim(),
    password: sha256(password),
    friends: [],
    friendRequests: [],
    sentRequests: [],
    createdAt: Date.now()
  };
  saveData();

  return res.json({ success: true, user: sanitizeUser(db.users[clean]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ error: 'Please enter username and password.' });
  }
  const clean = username.toLowerCase().trim();
  const user = db.users[clean];
  if (!user || user.password !== sha256(password)) {
    return res.json({ error: 'Invalid username or password.' });
  }
  return res.json({ success: true, user: sanitizeUser(user) });
});

// ── USER ROUTES ──
app.get('/api/user/:username', (req, res) => {
  const user = db.users[req.params.username.toLowerCase()];
  if (!user) return res.json({ error: 'User not found.' });
  return res.json(sanitizeUser(user));
});

// ── FRIEND ROUTES ──
app.post('/api/friend-request', (req, res) => {
  const { from, to } = req.body;
  const fromUser = db.users[from];
  const toUser = db.users[to];

  if (!fromUser || !toUser) return res.json({ error: 'User not found.' });
  if (from === to) return res.json({ error: "You can't add yourself." });
  if (fromUser.friends.includes(to)) return res.json({ error: 'You are already friends.' });
  if (fromUser.sentRequests.includes(to)) return res.json({ error: 'Request already sent.' });
  if (toUser.sentRequests.includes(from)) {
    // They already sent us a request — auto-accept
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
  return res.json({ success: true });
});

app.post('/api/friend-accept', (req, res) => {
  const { username, from } = req.body;
  const user = db.users[username];
  const requester = db.users[from];
  if (!user || !requester) return res.json({ error: 'User not found.' });

  user.friendRequests = user.friendRequests.filter(r => r !== from);
  requester.sentRequests = requester.sentRequests.filter(r => r !== username);
  if (!user.friends.includes(from)) user.friends.push(from);
  if (!requester.friends.includes(username)) requester.friends.push(username);
  saveData();

  io.to(from).emit('friend-accepted', { username, displayName: user.displayName });
  return res.json({ success: true });
});

app.post('/api/friend-reject', (req, res) => {
  const { username, from } = req.body;
  const user = db.users[username];
  const requester = db.users[from];
  if (!user || !requester) return res.json({ error: 'User not found.' });

  user.friendRequests = user.friendRequests.filter(r => r !== from);
  requester.sentRequests = requester.sentRequests.filter(r => r !== username);
  saveData();
  return res.json({ success: true });
});

app.post('/api/friend-remove', (req, res) => {
  const { username, target } = req.body;
  const user = db.users[username];
  const targetUser = db.users[target];
  if (!user || !targetUser) return res.json({ error: 'User not found.' });

  user.friends = user.friends.filter(f => f !== target);
  targetUser.friends = targetUser.friends.filter(f => f !== username);
  saveData();
  return res.json({ success: true });
});

// ── MESSAGE ROUTES ──
app.get('/api/messages/:a/:b', (req, res) => {
  const key = chatKey(req.params.a, req.params.b);
  return res.json(db.messages[key] || []);
});

// ── SOCKET.IO ──
const userSockets = {}; // username -> socketId

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('authenticate', (username) => {
    socket.username = username;
    socket.join(username);
    userSockets[username] = socket.id;
    // Broadcast online status to friends
    const user = db.users[username];
    if (user) {
      user.friends.forEach(f => io.to(f).emit('user-online', username));
    }
    console.log(`${username} authenticated`);
  });

  socket.on('send-message', ({ from, to, text }) => {
    if (!from || !to || !text || !text.trim()) return;
    const fromUser = db.users[from];
    const toUser = db.users[to];
    if (!fromUser || !toUser) return;
    if (!fromUser.friends.includes(to)) return; // Must be friends

    const key = chatKey(from, to);
    if (!db.messages[key]) db.messages[key] = [];

    const msg = {
      id: sha256(from + to + Date.now() + Math.random()),
      from,
      to,
      text: text.trim().substring(0, 2000),
      timestamp: Date.now()
    };

    db.messages[key].push(msg);
    // Keep only last 1000 messages per chat
    if (db.messages[key].length > 1000) {
      db.messages[key] = db.messages[key].slice(-1000);
    }
    saveData();

    io.to(from).emit('message', msg);
    io.to(to).emit('message', msg);
  });

  socket.on('typing', ({ from, to }) => {
    io.to(to).emit('typing', { from });
  });

  socket.on('stop-typing', ({ from, to }) => {
    io.to(to).emit('stop-typing', { from });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete userSockets[socket.username];
      const user = db.users[socket.username];
      if (user) {
        user.friends.forEach(f => io.to(f).emit('user-offline', socket.username));
      }
      console.log(`${socket.username} disconnected`);
    }
  });
});

// ── START ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SnapFlow running at http://0.0.0.0:${PORT}`);
});
