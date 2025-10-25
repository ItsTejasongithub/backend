const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", // set your frontend URL in Render
    methods: ["GET", "POST"]
  }
});


// Game configuration - EASILY ADJUSTABLE
const MONTH_DURATION = parseInt(process.env.MONTH_DURATION || '5000'); // Default: 5 seconds per month
const TOTAL_MONTHS = 240; // 20 years * 12 months
const STARTING_CAPITAL = 50000;

console.log(`⚙️  Game Speed: ${MONTH_DURATION}ms per month (${MONTH_DURATION * 12 / 1000}s per year)`);

// In-memory storage for rooms
const rooms = new Map();

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function calculateNetWorth(player, currentPrices) {
  let total = player.pocketCash;
  
  Object.entries(player.portfolio.stocks).forEach(([stockId, stock]) => {
    const currentPrice = currentPrices[stockId] || 0;
    total += stock.shares * currentPrice;
  });
  
  total += player.portfolio.savings;
  total += player.portfolio.mutualFunds;
  total += player.portfolio.ppf;
  
  player.portfolio.fixedDeposits.forEach(fd => {
    total += fd.amount + fd.profit;
  });
  
  if (player.portfolio.gold.grams > 0 && currentPrices.gold) {
    total += player.portfolio.gold.grams * currentPrices.gold;
  }
  
  return Math.round(total);
}

function getLeaderboard(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  
  const leaderboard = Object.values(room.players).map(player => {
    const netWorth = calculateNetWorth(player, room.currentPrices);
    const growth = ((netWorth / STARTING_CAPITAL - 1) * 100).toFixed(2);
    
    return {
      id: player.id,
      name: player.name,
      netWorth,
      pocketCash: player.pocketCash,
      growth: parseFloat(growth),
      portfolioValue: netWorth - player.pocketCash
    };
  }).sort((a, b) => b.netWorth - a.netWorth);
  
  return leaderboard;
}

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);
  
  socket.on('create-room', (data) => {
    const { playerName, gameData } = data;
    const roomCode = generateRoomCode();
    
    rooms.set(roomCode, {
      code: roomCode,
      host: socket.id,
      players: {},
      gameData: gameData,
      currentPrices: {},
      gameStartYear: gameData.gameStartYear,
      currentMonth: 0,
      status: 'waiting',
      startTime: null,
      timer: null,
      events: [],
      yearEvents: gameData.yearEvents || {}
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
    
    console.log(`Room ${roomCode} created by ${playerName}`);
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
    
    console.log(`${playerName} joined room ${roomCode}`);
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
    
    room.status = 'playing';
    room.startTime = Date.now();
    
    // Initialize current prices
    room.gameData.stocks.forEach(stock => {
      const actualYear = room.gameStartYear;
      room.currentPrices[stock.id] = stock.prices[actualYear];
    });
    room.currentPrices.gold = room.gameData.gold.prices[room.gameStartYear];
    
    startMonthTimer(roomCode);
    
    const initialLeaderboard = getLeaderboard(roomCode);
    
    io.to(roomCode).emit('game-started', {
      startTime: room.startTime,
      duration: TOTAL_MONTHS * MONTH_DURATION,
      currentPrices: room.currentPrices,
      leaderboard: initialLeaderboard,
      monthDuration: MONTH_DURATION
    });
    
    console.log(`Game started in room ${roomCode} - ${MONTH_DURATION}ms per month`);
  });
  
  socket.on('update-networth', (data) => {
    const { netWorth, cash, portfolioValue } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player) return;
    
    player.cachedNetWorth = netWorth;
    player.pocketCash = cash;
    
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
    stock.avgPrice = (stock.avgPrice * stock.shares + cost) / (stock.shares + shares);
    stock.shares += shares;
    
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
      pocketCash: player.pocketCash
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
      pocketCash: player.pocketCash
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
    const goldPrice = room.currentPrices.gold;
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
    
    delete room.players[socket.id];
    
    if (room.host === socket.id) {
      const remainingPlayers = Object.keys(room.players);
      if (remainingPlayers.length > 0) {
        room.host = remainingPlayers[0];
        room.players[room.host].isHost = true;
        io.to(roomCode).emit('new-host', { hostId: room.host });
      }
    }
    
    if (Object.keys(room.players).length === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(roomCode);
      console.log(`Room ${roomCode} deleted (empty)`);
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
    
    console.log(`Player ${socket.id} disconnected from room ${roomCode}`);
  });
});

// Month progression timer
function startMonthTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  console.log(`Starting month timer for room ${roomCode} - ${MONTH_DURATION}ms intervals`);
  
  room.timer = setInterval(() => {
    if (room.status !== 'playing') {
      clearInterval(room.timer);
      return;
    }
    
    room.currentMonth++;
    const currentYear = Math.floor(room.currentMonth / 12);
    const monthInYear = room.currentMonth % 12;
    
    console.log(`Room ${roomCode} - Month ${room.currentMonth} (Year ${currentYear}, Month ${monthInYear})`);
    
    // Update prices based on current year
    room.gameData.stocks.forEach(stock => {
      const actualYear = room.gameStartYear + currentYear;
      const nextYear = room.gameStartYear + currentYear + 1;
      
      if (stock.prices[actualYear] !== undefined && stock.prices[nextYear] !== undefined) {
        // Interpolate price between years
        const startPrice = stock.prices[actualYear];
        const endPrice = stock.prices[nextYear];
        const interpolatedPrice = startPrice + (endPrice - startPrice) * (monthInYear / 12);
        room.currentPrices[stock.id] = Math.round(interpolatedPrice);
      } else {
        room.currentPrices[stock.id] = stock.prices[actualYear] || stock.prices[stock.prices.length - 1];
      }
    });
    
    const actualYear = room.gameStartYear + currentYear;
    const nextYear = room.gameStartYear + currentYear + 1;
    if (room.gameData.gold.prices[actualYear] !== undefined && room.gameData.gold.prices[nextYear] !== undefined) {
      const startPrice = room.gameData.gold.prices[actualYear];
      const endPrice = room.gameData.gold.prices[nextYear];
      room.currentPrices.gold = Math.round(startPrice + (endPrice - startPrice) * (monthInYear / 12));
    } else {
      room.currentPrices.gold = room.gameData.gold.prices[actualYear] || room.gameData.gold.prices[room.gameData.gold.prices.length - 1];
    }
    
    // Apply monthly returns to investments
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
    
    // Check for yearly events (at month 0 of each year)
    if (monthInYear === 0) {
      const yearEvent = room.yearEvents[currentYear];
      if (yearEvent) {
        io.to(roomCode).emit('year-event', {
          year: currentYear,
          month: room.currentMonth,
          event: yearEvent
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
      leaderboard: leaderboard
    });
    
    // End game after 240 months (20 years)
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
  
  console.log(`Game ended in room ${roomCode}`);
  
  setTimeout(() => {
    rooms.delete(roomCode);
    console.log(`Room ${roomCode} cleaned up`);
  }, 5 * 60 * 1000);
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    monthDuration: `${MONTH_DURATION}ms`,
    yearDuration: `${MONTH_DURATION * 12 / 1000}s`,
    rooms: Array.from(rooms.values()).map(room => ({
      code: room.code,
      players: Object.keys(room.players).length,
      status: room.status,
      currentMonth: room.currentMonth,
      currentYear: Math.floor(room.currentMonth / 12)
    }))
  });
});

const PORT = process.env.PORT || 3000; // Render assigns PORT automatically

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Share this URL with your frontend: https://your-render-app.onrender.com`);
});


module.exports = { app, io };