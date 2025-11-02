const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

console.log(`⚙️ Game Speed: ${MONTH_DURATION}ms per month (${MONTH_DURATION * 12 / 1000}s per year)`);
console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
console.log(`🔌 Port: ${process.env.PORT || 3000}`);

const rooms = new Map();

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getLeaderboard(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  
  const leaderboard = Object.values(room.players).map(player => {
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

function getCurrentPrice(asset, gameStartYear, currentMonth) {
  const yearOffset = Math.floor(currentMonth / 12);
  const monthInYear = currentMonth % 12;

  // Calculate absolute year
  const absoluteYear = gameStartYear + yearOffset;

  // Calculate index in asset's price array
  // If asset has startYear, use it to calculate the correct index
  let priceIndex, nextPriceIndex;
  if (asset.startYear !== undefined) {
    priceIndex = absoluteYear - asset.startYear;
    nextPriceIndex = priceIndex + 1;
  } else {
    // Fallback for old format without startYear
    priceIndex = gameStartYear + yearOffset;
    nextPriceIndex = priceIndex + 1;
  }

  if (asset.prices[priceIndex] !== undefined && asset.prices[nextPriceIndex] !== undefined) {
    const startPrice = asset.prices[priceIndex];
    const endPrice = asset.prices[nextPriceIndex];
    return Math.round(startPrice + (endPrice - startPrice) * (monthInYear / 12));
  }

  return asset.prices[priceIndex] || asset.prices[asset.prices.length - 1] || 0;
}

function generateRandomEvents(randomAssets) {
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
    ]
  };

  const events = {};
  const usedLossEvents = new Set();
  const usedGainEvents = new Set();
  
  // Fixed unlocks
  events[0] = { type: 'unlock', message: 'Savings Account ready', unlock: 'savings' };
  events[1] = { type: 'unlock', message: 'Fixed Deposits now available', unlock: 'fixedDeposits' };
  events[2] = { type: 'unlock', message: 'Gold investment unlocked', unlock: 'gold' };
  events[3] = { type: 'unlock', message: 'Stock market access unlocked', unlock: 'stocks' };
  
  // Random unlocks at years 5, 6, 7 (passed from client via randomAssets array)
  if (randomAssets && randomAssets.length > 0) {
    const displayNames = {
      'mutualFunds': 'Mutual Funds',
      'indexFunds': 'Index Funds',
      'commodities': 'Commodities',
      'reit': 'REITs',
      'crypto': 'Cryptocurrency',
      'forex': 'Foreign Exchange'
    };
    
    // Only create unlock events for years 5, 6, 7 if we have assets
    if (randomAssets.length >= 1) {
      events[5] = { 
        type: 'unlock', 
        message: `${displayNames[randomAssets[0]] || randomAssets[0]} now available`, 
        unlock: randomAssets[0] 
      };
    }
    if (randomAssets.length >= 2) {
      events[6] = { 
        type: 'unlock', 
        message: `${displayNames[randomAssets[1]] || randomAssets[1]} now available`, 
        unlock: randomAssets[1] 
      };
    }
    if (randomAssets.length >= 3) {
      events[7] = { 
        type: 'unlock', 
        message: `${displayNames[randomAssets[2]] || randomAssets[2]} now available`, 
        unlock: randomAssets[2] 
      };
    }
  }
  
  // Generate random loss/gain events
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
    
    // Log gold data received
    if (gameData.gold) {
      console.log(`💰 Gold data received: startYear=${gameData.gold.startYear}, prices count=${gameData.gold.prices?.length}, id=${gameData.gold.id}, name=${gameData.gold.name}`);
      if (gameData.gold.prices && gameData.gold.prices.length > 0) {
        console.log(`💰 First 3 gold prices: [${gameData.gold.prices.slice(0, 3).join(', ')}]`);
        console.log(`💰 Last 3 gold prices: [${gameData.gold.prices.slice(-3).join(', ')}]`);
      }
    } else {
      console.log(`⚠️ No gold data received`);
    }

    rooms.set(roomCode, {
      code: roomCode,
      host: socket.id,
      players: {},
      gameData: {
        stocks: gameData.stocks,
        mutualFunds: gameData.mutualFunds || [],
        indexFunds: gameData.indexFunds || [],
        commodities: gameData.commodities || [],
        crypto: gameData.crypto || [],
        reit: gameData.reit || [],
        forex: gameData.forex || [],
        randomAssets: gameData.randomAssets || [],
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
    
    console.log('📊 Creating player with randomAssets:', gameData.randomAssets);
    const player = {
      id: socket.id,
      name: playerName,
      isHost: true,
      pocketCash: STARTING_CAPITAL,
      netWorth: STARTING_CAPITAL,
      portfolio: {
        savings: 0,
        fixedDeposits: [],
        mutualFunds: [],
        indexFunds: [],
        commodities: [],
        reit: [],
        crypto: [],
        forex: [],
        stocks: {},
        gold: 0
      },
      yearEvents: generateRandomEvents(gameData.randomAssets)
    };
    console.log('🎲 Generated events for years 5-7:', player.yearEvents[5], player.yearEvents[6], player.yearEvents[7]);
    
    const room = rooms.get(roomCode);
    room.players[socket.id] = player;
    
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    socket.emit('room-created', {
      roomCode,
      room: {
        ...room,
        players: Object.values(room.players)
      }
    });
    
    console.log(`👤 ${playerName} created room ${roomCode}`);
  });
  
  socket.on('join-room', (data) => {
    const { roomCode, playerName } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (room.status !== 'waiting') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    const player = {
      id: socket.id,
      name: playerName,
      isHost: false,
      pocketCash: STARTING_CAPITAL,
      netWorth: STARTING_CAPITAL,
      portfolio: {
        savings: 0,
        fixedDeposits: [],
        mutualFunds: [],
        indexFunds: [],
        commodities: [],
        reit: [],
        crypto: [],
        forex: [],
        stocks: {},
        gold: 0
      },
      yearEvents: generateRandomEvents(room.gameData.randomAssets)
    };
    
    room.players[socket.id] = player;
    
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    socket.emit('room-joined', {
      roomCode,
      room: {
        ...room,
        players: Object.values(room.players)
      }
    });
    
    io.to(roomCode).emit('player-joined', {
      player,
      totalPlayers: Object.keys(room.players).length
    });
    
    console.log(`👤 ${playerName} joined room ${roomCode}`);
  });
  
  socket.on('start-game', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) {
      socket.emit('error', { message: 'Only host can start game' });
      return;
    }
    
    room.status = 'playing';
    room.startTime = Date.now();
    
    // Initialize prices
    room.gameData.stocks.forEach(stock => {
      room.currentPrices[stock.id] = getCurrentPrice(stock, room.gameStartYear, 0);
    });
    
    if (room.gameData.mutualFunds) {
      room.gameData.mutualFunds.forEach(mf => {
        room.currentPrices[mf.id] = getCurrentPrice(mf, room.gameStartYear, 0);
      });
    }
    
    if (room.gameData.indexFunds) {
      room.gameData.indexFunds.forEach(idx => {
        room.currentPrices[idx.id] = getCurrentPrice(idx, room.gameStartYear, 0);
      });
    }
    
    if (room.gameData.commodities) {
      room.gameData.commodities.forEach(comm => {
        room.currentPrices[comm.id] = getCurrentPrice(comm, room.gameStartYear, 0);
      });
    }
    
    if (room.gameData.crypto) {
      room.gameData.crypto.forEach(cr => {
        room.currentPrices[cr.id] = getCurrentPrice(cr, room.gameStartYear, 0);
      });
    }
    
    if (room.gameData.reit) {
      room.gameData.reit.forEach(rt => {
        room.currentPrices[rt.id] = getCurrentPrice(rt, room.gameStartYear, 0);
      });
    }
    
    if (room.gameData.forex) {
      room.gameData.forex.forEach(fx => {
        room.currentPrices[fx.id] = getCurrentPrice(fx, room.gameStartYear, 0);
      });
    }
    
    if (room.gameData.gold && room.gameData.gold.prices && room.gameData.gold.startYear) {
      room.currentPrices.gold = getCurrentPrice(room.gameData.gold, room.gameStartYear, 0);
    } else if (room.gameData.gold && room.gameData.gold.prices) {
      // Fallback for old format
      const goldPrice = room.gameData.gold.prices[room.gameStartYear] || 350;
      room.currentPrices.gold = goldPrice;
    }
    
    io.to(roomCode).emit('game-started', {
      currentPrices: room.currentPrices,
      gameStartYear: room.gameStartYear,
      availableInvestments: room.availableInvestments,
      leaderboard: getLeaderboard(roomCode),
      mutualFunds: room.gameData.mutualFunds || [],
      indexFunds: room.gameData.indexFunds || [],
      commodities: room.gameData.commodities || [],
      crypto: room.gameData.crypto || [],
      reit: room.gameData.reit || [],
      forex: room.gameData.forex || []
    });
    
    startMonthTimer(roomCode);
    console.log(`🎮 Game started in room ${roomCode}`);
  });
  
  socket.on('buy-stock', (data) => {
    const { stockId, shares } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') {
      socket.emit('error', { message: 'Game not active' });
      return;
    }
    
    const player = room.players[socket.id];
    if (!player) return;
    
    const currentPrice = room.currentPrices[stockId];
    const cost = currentPrice * shares;
    
    if (player.pocketCash < cost) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= cost;
    
    if (!player.portfolio.stocks[stockId]) {
      player.portfolio.stocks[stockId] = { shares: 0, avgPrice: 0 };
    }
    
    const stock = player.portfolio.stocks[stockId];
    const totalCost = (stock.avgPrice * stock.shares) + (currentPrice * shares);
    stock.shares += shares;
    stock.avgPrice = totalCost / stock.shares;
    
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
    
    if (!roomCode) return;
    
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
  
  socket.on('buy-mutual-fund', (data) => {
    const { mfId, amount } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player || player.pocketCash < amount) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    const currentNav = room.currentPrices[mfId];
    const units = amount / currentNav;
    
    player.pocketCash -= amount;
    
    let existing = player.portfolio.mutualFunds.find(mf => mf.id === mfId);
    if (!existing) {
      existing = { id: mfId, units: 0, avgPrice: 0 };
      player.portfolio.mutualFunds.push(existing);
    }
    
    const totalCost = (existing.avgPrice * existing.units) + amount;
    existing.units += units;
    existing.avgPrice = totalCost / existing.units;
    
    socket.emit('investment-success', { type: 'buy-mutual-fund', mfId, units, pocketCash: player.pocketCash });
    io.to(roomCode).emit('leaderboard-update', { leaderboard: getLeaderboard(roomCode) });
  });
  
  socket.on('sell-mutual-fund', (data) => {
    const { mfId, units } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player) return;
    
    const existing = player.portfolio.mutualFunds.find(mf => mf.id === mfId);
    if (!existing || existing.units < units) {
      socket.emit('error', { message: 'Insufficient units' });
      return;
    }
    
    const currentNav = room.currentPrices[mfId];
    const revenue = units * currentNav;
    
    player.pocketCash += revenue;
    existing.units -= units;
    
    if (existing.units < 0.01) {
      player.portfolio.mutualFunds = player.portfolio.mutualFunds.filter(mf => mf.id !== mfId);
    }
    
    socket.emit('investment-success', { type: 'sell-mutual-fund', mfId, units, pocketCash: player.pocketCash });
    io.to(roomCode).emit('leaderboard-update', { leaderboard: getLeaderboard(roomCode) });
  });
  
  socket.on('buy-asset', (data) => {
    const { assetId, units, category } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') {
      socket.emit('error', { message: 'Game not active' });
      return;
    }
    
    const player = room.players[socket.id];
    if (!player) return;
    
    const currentPrice = room.currentPrices[assetId];
    if (!currentPrice) {
      socket.emit('error', { message: 'Asset not found' });
      return;
    }
    
    const cost = currentPrice * units;
    
    if (player.pocketCash < cost) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= cost;
    
    // Find or create asset entry
    let existing = player.portfolio[category].find(a => a.id === assetId);
    if (!existing) {
      existing = { id: assetId, units: 0, avgPrice: 0 };
      player.portfolio[category].push(existing);
    }
    
    // Calculate weighted average
    const totalCost = (existing.avgPrice * existing.units) + cost;
    existing.units += units;
    existing.avgPrice = totalCost / existing.units;

    socket.emit('investment-success', {
      type: 'buy-asset',
      assetId,
      units: existing.units,  // Send total units after purchase
      avgPrice: existing.avgPrice,  // Send updated average price
      category,
      pocketCash: player.pocketCash
    });
    io.to(roomCode).emit('leaderboard-update', { leaderboard: getLeaderboard(roomCode) });
  });
  
  socket.on('sell-asset', (data) => {
    const { assetId, units, category } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') {
      socket.emit('error', { message: 'Game not active' });
      return;
    }
    
    const player = room.players[socket.id];
    if (!player) return;
    
    const existing = player.portfolio[category].find(a => a.id === assetId);
    if (!existing || existing.units < units) {
      socket.emit('error', { message: 'Insufficient units' });
      return;
    }
    
    const currentPrice = room.currentPrices[assetId];
    if (!currentPrice) {
      socket.emit('error', { message: 'Asset not found' });
      return;
    }
    
    const revenue = units * currentPrice;
    
    player.pocketCash += revenue;
    existing.units -= units;

    // Remove if all units sold
    if (existing.units < 0.01) {
      player.portfolio[category] = player.portfolio[category].filter(a => a.id !== assetId);

      socket.emit('investment-success', {
        type: 'sell-asset',
        assetId,
        units: 0,  // All units sold
        avgPrice: 0,
        category,
        pocketCash: player.pocketCash
      });
    } else {
      socket.emit('investment-success', {
        type: 'sell-asset',
        assetId,
        units: existing.units,  // Send remaining units after sale
        avgPrice: existing.avgPrice,  // Keep same average price
        category,
        pocketCash: player.pocketCash
      });
    }

    io.to(roomCode).emit('leaderboard-update', { leaderboard: getLeaderboard(roomCode) });
  });
  
  socket.on('invest-savings', (data) => {
    const { amount } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player || player.pocketCash < amount) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= amount;
    player.portfolio.savings += amount;
    
    socket.emit('investment-success', { type: 'savings', amount, pocketCash: player.pocketCash });
  });
  
  socket.on('buy-gold', (data) => {
    const { grams } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    const goldPrice = room.currentPrices.gold || 350;
    const cost = grams * goldPrice;
    
    if (!player || player.pocketCash < cost) {
      socket.emit('error', { message: 'Insufficient funds' });
      return;
    }
    
    player.pocketCash -= cost;
    player.portfolio.gold += grams;
    
    socket.emit('investment-success', { type: 'gold', grams, pocketCash: player.pocketCash });
    io.to(roomCode).emit('leaderboard-update', { leaderboard: getLeaderboard(roomCode) });
  });
  
  socket.on('update-networth', (data) => {
    const { netWorth, cash } = data;
    const roomCode = socket.roomCode;
    
    if (!roomCode) return;
    
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    
    const player = room.players[socket.id];
    if (!player) return;
    
    player.netWorth = netWorth;
    player.pocketCash = cash;
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
    
    // Update all asset prices
    const updatePrices = (assets) => {
      assets.forEach(asset => {
        room.currentPrices[asset.id] = getCurrentPrice(asset, room.gameStartYear, room.currentMonth);
      });
    };
    
    updatePrices(room.gameData.stocks);
    if (room.gameData.mutualFunds) updatePrices(room.gameData.mutualFunds);
    if (room.gameData.indexFunds) updatePrices(room.gameData.indexFunds);
    if (room.gameData.commodities) updatePrices(room.gameData.commodities);
    if (room.gameData.crypto) updatePrices(room.gameData.crypto);
    if (room.gameData.reit) updatePrices(room.gameData.reit);
    if (room.gameData.forex) updatePrices(room.gameData.forex);
    
    // Update gold price
    if (room.gameData.gold && room.gameData.gold.prices && room.gameData.gold.startYear) {
      room.currentPrices.gold = getCurrentPrice(room.gameData.gold, room.gameStartYear, room.currentMonth);
    } else if (room.gameData.gold && room.gameData.gold.prices) {
      // Fallback for old format without startYear
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
    
    // Check for yearly events
    if (monthInYear === 0 && currentYear > 0) {
      Object.keys(room.players).forEach(playerId => {
        const player = room.players[playerId];
        const yearEvent = player.yearEvents?.[currentYear];
        
        if (yearEvent) {
          if (yearEvent.unlock && !room.availableInvestments.includes(yearEvent.unlock)) {
            room.availableInvestments.push(yearEvent.unlock);
          }
          
          io.to(playerId).emit('year-event', {
            year: currentYear,
            month: room.currentMonth,
            event: yearEvent,
            availableInvestments: room.availableInvestments
          });
        }
      });
    }
    
    const leaderboard = getLeaderboard(roomCode);
    
    io.to(roomCode).emit('month-update', {
      currentMonth: room.currentMonth,
      currentYear: currentYear,
      monthInYear: monthInYear,
      gameStartYear: room.gameStartYear,
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