const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const MONTH_DURATION = parseInt(process.env.MONTH_DURATION || '5000');
const TOTAL_MONTHS = 240;
const STARTING_CAPITAL = 50000;

console.log("ENV VALUE:", process.env.MONTH_DURATION);
console.log("URL:", process.env.FRONTEND_URL);
console.log(`⚙️ Game Speed: ${MONTH_DURATION}ms per month (${MONTH_DURATION * 12 / 1000}s per year)`);
console.log(`port: ${process.env.PORT}`);


const rooms = new Map();

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ✅ FIX #1: SIMPLIFIED LEADERBOARD - Just use client-reported networth
function getLeaderboard(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  
  const leaderboard = Object.values(room.players).map(player => {
    // Use client's self-reported networth (they calculate it accurately)
    const netWorth = player.netWorth || STARTING_CAPITAL;
    const growth = ((netWorth / STARTING_CAPITAL - 1) * 100).toFixed(2);
    
    return {
      id: player.id,
      name: player.name,
      netWorth: netWorth,
      pocketCash: player.pocketCash || 0,
      growth: parseFloat(growth)
    };
  }).sort((a, b) => b.netWorth - a.netWorth);
  
  return leaderboard;
}

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

function generateRandomEvents() {
  const EVENT_POOL = {
    losses: [
    { message: 'House robbery during Diwali', amount: -15000 },
    { message: 'Family medical emergency', amount: -30000 },
    { message: 'Vehicle repair after monsoon', amount: -20000 },
    { message: 'Wedding shopping expenses', amount: -15000 },
    { message: 'Health insurance deductible', amount: -25000 },
    { message: 'Home repairs after flooding', amount: -45000 },
    { message: 'Laptop suddenly stopped working', amount: -50000 },
    { message: 'Legal fees for property dispute', amount: -35000 },
    { message: 'AC breakdown in peak summer', amount: -18000 },
    { message: 'Parent hospitalization costs', amount: -40000 },
    { message: 'Car accident - insurance excess', amount: -22000 },
    { message: 'Stolen mobile phone', amount: -12000 },
    { message: 'Urgent home appliance replacement', amount: -28000 },
    { message: 'Child school fees increase', amount: -15000 },
    { message: 'Unexpected tax liability', amount: -35000 },
    { message: 'Emergency dental treatment', amount: -18000 },
    { message: 'Bike accident repair', amount: -14000 },
    { message: 'Flooding damaged furniture', amount: -25000 },
    { message: 'Friend wedding gift expected', amount: -10000 },
    { message: 'Pet medical emergency', amount: -20000 }
  ],
  gains: [
    { message: 'Won Kerala lottery!', amount: 25000 },
    { message: 'Diwali bonus from company', amount: 50000 },
    { message: 'Freelance project bonus', amount: 40000 },
    { message: 'Side business profit', amount: 35000 },
    { message: 'Performance bonus at work', amount: 45000 },
    { message: 'Tax refund received', amount: 20000 },
    { message: 'Sold old items online', amount: 15000 },
    { message: 'Investment dividend received', amount: 30000 }
  ],
  unlocks: [
    { message: 'Fixed Deposits now available', unlock: 'fixedDeposits', year: 1 },
    { message: 'Mutual Funds now available', unlock: 'mutualFunds', year: 2 },
    { message: 'Stock market access unlocked', unlock: 'stocks', year: 3 },
    { message: 'Gold investment available', unlock: 'gold', year: 10 },
    { message: 'PPF account opened', unlock: 'ppf', year: 15 }
  ]
  };

  // Copy the entire generateRandomEvents logic from Game.jsx
  const events = {};
  const usedLossEvents = new Set();
  const usedGainEvents = new Set();
  
  EVENT_POOL.unlocks.forEach(unlock => {
    events[unlock.year] = { type: 'unlock', message: unlock.message, unlock: unlock.unlock };
  });
  
  let nextEventMonth = Math.floor(Math.random() * 12) + 24;
  
  while (nextEventMonth < 240) {
    const eventYear = Math.floor(nextEventMonth / 12);
    
    if (!events[eventYear]) {
      const isLoss = Math.random() < 0.6;
      
      if (isLoss) {
        let eventIndex;
        let attempts = 0;
        do {
          eventIndex = Math.floor(Math.random() * EVENT_POOL.losses.length);
          attempts++;
        } while (usedLossEvents.has(eventIndex) && attempts < 20);
        
        usedLossEvents.add(eventIndex);
        const lossEvent = EVENT_POOL.losses[eventIndex];
        events[eventYear] = { type: 'loss', message: lossEvent.message, amount: lossEvent.amount };
      } else {
        let eventIndex;
        let attempts = 0;
        do {
          eventIndex = Math.floor(Math.random() * EVENT_POOL.gains.length);
          attempts++;
        } while (usedGainEvents.has(eventIndex) && attempts < 20);
        
        usedGainEvents.add(eventIndex);
        const gainEvent = EVENT_POOL.gains[eventIndex];
        events[eventYear] = { type: 'gain', message: gainEvent.message, amount: gainEvent.amount };
      }
    }
    
    nextEventMonth += Math.floor(Math.random() * 13) + 24;
  }
  
  return events;
}



io.on('connection', (socket) => {
  console.log(`✅ New client connected: ${socket.id}`);
  
  socket.on('create-room', (data) => {
    const { playerName, gameData } = data;
    const roomCode = generateRoomCode();
    
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
        
      },
      currentPrices: {},
      gameStartYear: gameData.gameStartYear || 0,
      currentMonth: 0,
      status: 'waiting',
      startTime: null,
      timer: null,
      events: [],
      availableInvestments: ['savings']
    });
    
    const player = {
      id: socket.id,
      name: playerName,
      isHost: true,
      pocketCash: STARTING_CAPITAL,
      netWorth: STARTING_CAPITAL, // ✅ ADD: Track networth
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
      netWorth: STARTING_CAPITAL, // ✅ ADD: Track networth
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
    Object.keys(room.players).forEach(playerId => {
      room.players[playerId].yearEvents = generateRandomEvents();
    });
    room.startTime = Date.now();
    room.currentMonth = 0;
    
    // Initialize current prices
    room.gameData.stocks.forEach(stock => {
      room.currentPrices[stock.id] = getCurrentPrice(stock, room.gameStartYear, 0);
    });
    
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
      availableInvestments: room.availableInvestments
    });
    
    console.log(`🎮 Game started in room ${roomCode} - ${Object.keys(room.players).length} players`);
  });
  
  // ✅ FIX #2: Simplified networth update - just store what client sends
  socket.on('update-networth', (data) => {
    const { netWorth, cash } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player) return;
    
    // Store client's self-calculated networth
    player.netWorth = netWorth;
    player.pocketCash = cash;
    
    // Update leaderboard
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
      portfolio: player.portfolio.stocks
    });
    
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
      portfolio: player.portfolio.stocks
    });
    
    io.to(roomCode).emit('leaderboard-update', {
      leaderboard: getLeaderboard(roomCode),
      currentMonth: room.currentMonth
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
    
    if (room.host === socket.id) {
      const remainingPlayers = Object.keys(room.players);
      if (remainingPlayers.length > 0) {
        room.host = remainingPlayers[0];
        room.players[room.host].isHost = true;
        io.to(roomCode).emit('new-host', { hostId: room.host });
        console.log(`👑 New host in room ${roomCode}: ${room.players[room.host].name}`);
      }
    }
    
    if (Object.keys(room.players).length === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(roomCode);
      console.log(`🗑️ Room ${roomCode} deleted (empty)`);
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

// ✅ FIX #3: Server controls ALL time progression
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
    
    // Check for yearly events and unlock investments
    if (monthInYear === 0 && currentYear > 0) {
      Object.keys(room.players).forEach(playerId => {
        const player = room.players[playerId];
        const yearEvent = player.yearEvents?.[currentYear];
        
        if (yearEvent) {
          if (yearEvent.unlock && !room.availableInvestments.includes(yearEvent.unlock)) {
            room.availableInvestments.push(yearEvent.unlock);
          }
          
          // Send event to ONLY this player
          io.to(playerId).emit('year-event', {
            year: currentYear,
            month: room.currentMonth,
            event: yearEvent,
            availableInvestments: room.availableInvestments
          });
        }
      });
    }
    
    // Broadcast month update with current time
    const leaderboard = getLeaderboard(roomCode);
    
    io.to(roomCode).emit('month-update', {
      currentMonth: room.currentMonth,
      currentYear: currentYear,
      monthInYear: monthInYear,
      currentPrices: room.currentPrices,
      leaderboard: leaderboard,
      availableInvestments: room.availableInvestments
    });
    
    if (room.currentMonth % 12 === 0) {
      console.log(`📅 Room ${roomCode} - Year ${currentYear} complete`);
    }
    
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
  console.log(`🏆 Winner: ${finalLeaderboard[0]?.name} with ₹${finalLeaderboard[0]?.netWorth}`);
  
  setTimeout(() => {
    rooms.delete(roomCode);
    console.log(`🗑️ Room ${roomCode} cleaned up`);
  }, 5 * 60 * 1000);
}

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
      stocks: room.gameData?.stocks?.length || 0,
      availableInvestments: room.availableInvestments
    }))
  });
});

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