const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Game configuration - EASILY ADJUSTABLE
const MONTH_DURATION = parseInt(process.env.MONTH_DURATION || '5000');
const TOTAL_MONTHS = 240; // 20 years * 12 months
const STARTING_CAPITAL = 50000;

console.log(`⚙️  Game Speed: ${MONTH_DURATION}ms per month (${MONTH_DURATION * 12 / 1000}s per year)`);

// In-memory storage for rooms
const rooms = new Map();

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// FIXED: Better networth calculation with proper price indexing
function calculateNetWorth(player, room) {
  let total = player.pocketCash || 0;
  
  // Calculate stock portfolio value
  Object.entries(player.portfolio.stocks || {}).forEach(([stockId, stock]) => {
    const currentPrice = room.currentPrices[stockId] || 0;
    total += (stock.shares || 0) * currentPrice;
  });
  
  // Add other investments
  total += player.portfolio.savings || 0;
  total += player.portfolio.mutualFunds || 0;
  total += player.portfolio.ppf || 0;
  
  // Add fixed deposits with profit
  (player.portfolio.fixedDeposits || []).forEach(fd => {
    total += (fd.amount || 0) + (fd.profit || 0);
  });
  
  // Add gold value
  if ((player.portfolio.gold?.grams || 0) > 0 && room.currentPrices.gold) {
    total += player.portfolio.gold.grams * room.currentPrices.gold;
  }
  
  return Math.round(total);
}

// FIXED: Leaderboard now uses room object for accurate calculation
function getLeaderboard(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  
  const leaderboard = Object.values(room.players).map(player => {
    const netWorth = calculateNetWorth(player, room);
    const growth = ((netWorth / STARTING_CAPITAL - 1) * 100).toFixed(2);
    
    return {
      id: player.id,
      name: player.name,
      netWorth,
      pocketCash: player.pocketCash || 0,
      growth: parseFloat(growth),
      portfolioValue: netWorth - (player.pocketCash || 0)
    };
  }).sort((a, b) => b.netWorth - a.netWorth); // Sort by networth descending
  
  return leaderboard;
}

// FIXED: Helper to get current price with proper year indexing
function getCurrentPrice(stock, gameStartYear, currentMonth) {
  const yearOffset = Math.floor(currentMonth / 12);
  const monthInYear = currentMonth % 12;
  const priceIndex = gameStartYear + yearOffset;
  const nextPriceIndex = priceIndex + 1;
  
  if (stock.prices[priceIndex] !== undefined && stock.prices[nextPriceIndex] !== undefined) {
    const startPrice = stock.prices[priceIndex];
    const endPrice = stock.prices[nextPriceIndex];
    return Math.round(startPrice + (endPrice - startPrice) * (monthInYear / 12));
  }
  
  return stock.prices[priceIndex] || stock.prices[stock.prices.length - 1] || 0;
}

io.on('connection', (socket) => {
  console.log(`✅ New client connected: ${socket.id}`);
  
  socket.on('create-room', (data) => {
    const { playerName, gameData } = data;
    const roomCode = generateRoomCode();
    
    // Validate gameData
    if (!gameData || !gameData.stocks || !Array.isArray(gameData.stocks)) {
      socket.emit('error', { message: 'Invalid game data' });
      return;
    }
    
    console.log(`🏠 Creating room ${roomCode} with ${gameData.stocks.length} stocks`);
    
    rooms.set(roomCode, {
      code: roomCode,
      host: socket.id,
      players: {},
      gameData: {
        stocks: gameData.stocks,
        gold: gameData.gold || { prices: [] },
        yearEvents: gameData.yearEvents || {}
      },
      currentPrices: {},
      gameStartYear: gameData.gameStartYear || 0,
      currentMonth: 0,
      status: 'waiting',
      startTime: null,
      timer: null,
      events: [],
      availableInvestments: ['savings'] // ✅ ADD THIS LINE - Start with just savings

    });
    
    const player = {
      id: socket.id,
      name: playerName,
      isHost: true,
      pocketCash: STARTING_CAPITAL,
      portfolio: {
        savings: 0,
        fixedDeposits: [],
        mutualFunds: 0,
        stocks: {},
        gold: { grams: 0 },
        ppf: 0
      },
      joinedAt: Date.now()
    };
    
    rooms.get(roomCode).players[socket.id] = player;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    socket.emit('room-created', {
      roomCode,
      player,
      room: rooms.get(roomCode)
    });
    
    console.log(`👤 Room ${roomCode} created by ${playerName}`);
  });
  
  socket.on('join-room', (data) => {
    const { roomCode, playerName } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (room.status === 'ended') {
      socket.emit('error', { message: 'Game has already ended' });
      return;
    }
    
    if (room.status === 'playing') {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }
    
    if (Object.keys(room.players).length >= 8) {
      socket.emit('error', { message: 'Room is full (max 8 players)' });
      return;
    }
    
    const player = {
      id: socket.id,
      name: playerName,
      isHost: false,
      pocketCash: STARTING_CAPITAL,
      portfolio: {
        savings: 0,
        fixedDeposits: [],
        mutualFunds: 0,
        stocks: {},
        gold: { grams: 0 },
        ppf: 0
      },
      joinedAt: Date.now()
    };
    
    room.players[socket.id] = player;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    socket.emit('room-joined', {
      roomCode,
      player,
      room
    });
    
    io.to(roomCode).emit('player-joined', {
      player: { id: player.id, name: player.name },
      totalPlayers: Object.keys(room.players).length
    });
    
    console.log(`👤 ${playerName} joined room ${roomCode}`);
  });
  
  socket.on('start-game', () => {
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.host !== socket.id) {
      socket.emit('error', { message: 'Only host can start the game' });
      return;
    }
    
    if (room.status !== 'waiting') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    if (Object.keys(room.players).length < 2) {
      socket.emit('error', { message: 'Need at least 2 players to start' });
      return;
    }
    
    room.status = 'playing';
    room.startTime = Date.now();
    room.currentMonth = 0;
    
    // Initialize current prices using the helper function
    room.gameData.stocks.forEach(stock => {
      room.currentPrices[stock.id] = getCurrentPrice(stock, room.gameStartYear, 0);
    });
    
    // Initialize gold price
    if (room.gameData.gold && room.gameData.gold.prices) {
      const goldPriceIndex = room.gameStartYear;
      room.currentPrices.gold = room.gameData.gold.prices[goldPriceIndex] || 350;
    }
    
    startMonthTimer(roomCode);
    
    const initialLeaderboard = getLeaderboard(roomCode);
    
    io.to(roomCode).emit('game-started', {
      startTime: room.startTime,
      duration: TOTAL_MONTHS * MONTH_DURATION,
      currentPrices: room.currentPrices,
      leaderboard: initialLeaderboard,
      monthDuration: MONTH_DURATION,
      availableInvestments: room.availableInvestments // ✅ ADD THIS LINE
    });
    
    console.log(`🎮 Game started in room ${roomCode} - ${Object.keys(room.players).length} players`);
  });
  
  socket.on('update-networth', (data) => {
    const { netWorth, cash, portfolioValue } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player) return;
    
    // Update player cash (client is source of truth for their own cash)
    player.pocketCash = cash;
    
    // Recalculate leaderboard with current prices
    const leaderboard = getLeaderboard(roomCode);
    
    io.to(roomCode).emit('leaderboard-update', {
      leaderboard: leaderboard,
      currentMonth: room.currentMonth
    });
  });
  
  socket.on('buy-stock', (data) => {
    const { stockId, shares } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') {
      socket.emit('error', { message: 'Game not active' });
      return;
    }
    
    const player = room.players[socket.id];
    if (!player) {
      socket.emit('error', { message: 'Player not found' });
      return;
    }
    
    const currentPrice = room.currentPrices[stockId];
    if (!currentPrice) {
      socket.emit('error', { message: 'Stock not available' });
      return;
    }
    
    const cost = currentPrice * shares;
    
    if (cost > player.pocketCash) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= cost;
    
    if (!player.portfolio.stocks[stockId]) {
      player.portfolio.stocks[stockId] = { shares: 0, avgPrice: 0 };
    }
    
    const stock = player.portfolio.stocks[stockId];
    const totalShares = stock.shares + shares;
    stock.avgPrice = (stock.avgPrice * stock.shares + cost) / totalShares;
    stock.shares = totalShares;
    
    room.events.push({
      type: 'buy',
      playerId: socket.id,
      playerName: player.name,
      stockId,
      shares,
      price: currentPrice,
      timestamp: Date.now(),
      month: room.currentMonth
    });
    
    socket.emit('transaction-success', {
      type: 'buy',
      stockId,
      shares,
      price: currentPrice,
      pocketCash: player.pocketCash,
      portfolio: player.portfolio.stocks  // ✅ ADD: Send updated portfolio
    });
    
    // Broadcast updated leaderboard
    io.to(roomCode).emit('leaderboard-update', {
      leaderboard: getLeaderboard(roomCode),
      currentMonth: room.currentMonth
    });
  });
  
  socket.on('sell-stock', (data) => {
    const { stockId, shares } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') {
      socket.emit('error', { message: 'Game not active' });
      return;
    }
    
    const player = room.players[socket.id];
    if (!player) return;
    
    const stock = player.portfolio.stocks[stockId];
    if (!stock || stock.shares < shares) {
      socket.emit('error', { message: 'Insufficient shares' });
      return;
    }
    
    const currentPrice = room.currentPrices[stockId];
    const revenue = currentPrice * shares;
    
    player.pocketCash += revenue;
    stock.shares -= shares;
    
    if (stock.shares === 0) {
      delete player.portfolio.stocks[stockId];
    }
    
    room.events.push({
      type: 'sell',
      playerId: socket.id,
      playerName: player.name,
      stockId,
      shares,
      price: currentPrice,
      timestamp: Date.now(),
      month: room.currentMonth
    });
    
    socket.emit('transaction-success', {
      type: 'sell',
      stockId,
      shares,
      price: currentPrice,
      pocketCash: player.pocketCash,
      portfolio: player.portfolio.stocks  // ✅ ADD: Send updated portfolio
    });
    
    io.to(roomCode).emit('leaderboard-update', {
      leaderboard: getLeaderboard(roomCode),
      currentMonth: room.currentMonth
    });
  });
  
  socket.on('invest-savings', (data) => {
    const { amount } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player || player.pocketCash < amount) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= amount;
    player.portfolio.savings += amount;
    
    socket.emit('investment-success', {
      type: 'savings',
      amount,
      pocketCash: player.pocketCash
    });
    
    io.to(roomCode).emit('leaderboard-update', {
      leaderboard: getLeaderboard(roomCode),
      currentMonth: room.currentMonth
    });
  });
  
  socket.on('buy-gold', (data) => {
    const { grams } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    const goldPrice = room.currentPrices.gold || 0;
    const cost = goldPrice * grams;
    
    if (!player || player.pocketCash < cost) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= cost;
    player.portfolio.gold.grams += grams;
    
    socket.emit('investment-success', {
      type: 'gold',
      grams,
      price: goldPrice,
      pocketCash: player.pocketCash
    });
    
    io.to(roomCode).emit('leaderboard-update', {
      leaderboard: getLeaderboard(roomCode),
      currentMonth: room.currentMonth
    });
  });
  
  socket.on('get-room-info', () => {
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    socket.emit('room-info', {
      room,
      leaderboard: getLeaderboard(roomCode)
    });
  });
  
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const player = room.players[socket.id];
    if (!player) return;
    
    console.log(`👋 ${player.name} disconnected from room ${roomCode}`);
    
    delete room.players[socket.id];
    
    // Handle host reassignment
    if (room.host === socket.id) {
      const remainingPlayers = Object.keys(room.players);
      if (remainingPlayers.length > 0) {
        room.host = remainingPlayers[0];
        room.players[room.host].isHost = true;
        io.to(roomCode).emit('new-host', { hostId: room.host });
        console.log(`👑 New host in room ${roomCode}: ${room.players[room.host].name}`);
      }
    }
    
    // Delete room if empty
    if (Object.keys(room.players).length === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(roomCode);
      console.log(`🗑️  Room ${roomCode} deleted (empty)`);
    } else {
      io.to(roomCode).emit('player-left', {
        playerId: socket.id,
        playerName: player.name,
        totalPlayers: Object.keys(room.players).length
      });
      
      io.to(roomCode).emit('leaderboard-update', {
        leaderboard: getLeaderboard(roomCode),
        currentMonth: room.currentMonth
      });
    }
  });
});

// Month progression timer - FIXED for proper price updates
function startMonthTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  console.log(`⏰ Starting month timer for room ${roomCode}`);
  
  room.timer = setInterval(() => {
    if (room.status !== 'playing') {
      clearInterval(room.timer);
      return;
    }
    
    room.currentMonth++;
    const currentYear = Math.floor(room.currentMonth / 12);
    const monthInYear = room.currentMonth % 12;
    
    // Update stock prices
    room.gameData.stocks.forEach(stock => {
      room.currentPrices[stock.id] = getCurrentPrice(stock, room.gameStartYear, room.currentMonth);
    });
    
    // Update gold price
    if (room.gameData.gold && room.gameData.gold.prices) {
      const yearOffset = Math.floor(room.currentMonth / 12);
      const monthInYearLocal = room.currentMonth % 12;
      const priceIndex = room.gameStartYear + yearOffset;
      const nextPriceIndex = priceIndex + 1;
      
      if (room.gameData.gold.prices[priceIndex] && room.gameData.gold.prices[nextPriceIndex]) {
        const startPrice = room.gameData.gold.prices[priceIndex];
        const endPrice = room.gameData.gold.prices[nextPriceIndex];
        room.currentPrices.gold = Math.round(startPrice + (endPrice - startPrice) * (monthInYearLocal / 12));
      } else {
        room.currentPrices.gold = room.gameData.gold.prices[priceIndex] || 350;
      }
    }
    
    // Apply monthly returns to all players
    Object.values(room.players).forEach(player => {
      player.portfolio.savings *= (1 + 4 / 100 / 12);
      player.portfolio.mutualFunds *= (1 + 12 / 100 / 12);
      player.portfolio.ppf *= (1 + 7.1 / 100 / 12);
      
      player.portfolio.fixedDeposits = player.portfolio.fixedDeposits.map(fd => ({
        ...fd,
        monthsElapsed: fd.monthsElapsed + 1,
        profit: fd.amount * (fd.roi / 100) * (fd.monthsElapsed + 1) / fd.duration
      }));
    });
    
// Check for yearly events
if (monthInYear === 0 && room.gameData.yearEvents) {
  const yearEvent = room.gameData.yearEvents[currentYear];
  if (yearEvent) {
    // ✅ ADD: Unlock investments on server side
    if (yearEvent.unlock && !room.availableInvestments.includes(yearEvent.unlock)) {
      room.availableInvestments.push(yearEvent.unlock);
      console.log(`🔓 Room ${roomCode} - Unlocked: ${yearEvent.unlock}`);
    }
    
    io.to(roomCode).emit('year-event', {
      year: currentYear,
      month: room.currentMonth,
      event: yearEvent,
      availableInvestments: room.availableInvestments // ✅ ADD: Send updated list
    });
  }
}
    
    // Broadcast month update with leaderboard
    const leaderboard = getLeaderboard(roomCode);
    
    io.to(roomCode).emit('month-update', {
      currentMonth: room.currentMonth,
      currentYear: currentYear,
      monthInYear: monthInYear,
      currentPrices: room.currentPrices,
      leaderboard: leaderboard,
      availableInvestments: room.availableInvestments // ✅ ADD THIS LINE
    });
    
    if (room.currentMonth % 12 === 0) {
      console.log(`📅 Room ${roomCode} - Year ${currentYear} complete`);
    }
    
    // End game after 240 months
    if (room.currentMonth >= TOTAL_MONTHS) {
      endGame(roomCode);
    }
  }, MONTH_DURATION);
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.status = 'ended';
  clearInterval(room.timer);
  
  const finalLeaderboard = getLeaderboard(roomCode);
  
  io.to(roomCode).emit('game-ended', {
    leaderboard: finalLeaderboard,
    events: room.events,
    duration: Date.now() - room.startTime
  });
  
  console.log(`🏁 Game ended in room ${roomCode}`);
  console.log(`🏆 Winner: ${finalLeaderboard[0]?.name} with ${finalLeaderboard[0]?.netWorth}`);
  
  // Cleanup after 5 minutes
  setTimeout(() => {
    rooms.delete(roomCode);
    console.log(`🗑️  Room ${roomCode} cleaned up`);
  }, 5 * 60 * 1000);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    monthDuration: `${MONTH_DURATION}ms`,
    yearDuration: `${MONTH_DURATION * 12 / 1000}s`,
    totalMonths: TOTAL_MONTHS,
    rooms: Array.from(rooms.values()).map(room => ({
      code: room.code,
      players: Object.keys(room.players).length,
      status: room.status,
      currentMonth: room.currentMonth,
      currentYear: Math.floor(room.currentMonth / 12),
      stocks: room.gameData?.stocks?.length || 0
    }))
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Build Your Dhan - Multiplayer Server',
    version: '2.0',
    activeGames: rooms.size
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Month duration: ${MONTH_DURATION}ms`);
  console.log(`🎮 Ready for multiplayer games!`);
});

module.exports = { app, io };