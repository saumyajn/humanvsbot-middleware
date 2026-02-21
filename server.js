const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const allowedOrigins = [
    "https://humanvsbot-frontend.vercel.app", // Your Web App
    "http://localhost",                       // Android App default
    "capacitor://localhost"                   // iOS App default
];
const app = express();
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST']
}));
app.use(express.json());
const PORT = process.env.PORT || 3000; 

// 2. Get your Python URL from a DIFFERENT environment variable
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL;
const httpServer = createServer(app);

const io = new Server(httpServer, {
   cors: {
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"]
    }
});

let waitingQueue = [];
// NEW: Keep track of which rooms are AI vs Human
const activeRooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('find_match', () => {
        const startTime = Date.now();
        const MATCH_DELAY = 10000;

        if (waitingQueue.length > 0) {
            // 1. HUMAN MATCH FOUND
            const opponent = waitingQueue.shift();
            const roomId = uuidv4();

            socket.join(roomId);
            opponent.socket.join(roomId);

            // Mark room as human
            activeRooms.set(roomId, { type: 'human' });

            const timeElapsed = Date.now() - opponent.startTime;
            const remainingTime = Math.max(0, MATCH_DELAY - timeElapsed);

            setTimeout(() => {
                io.to(roomId).emit('match_found', { roomId, opponent: 'human' });
            }, remainingTime);

        } else {
            // 2. START THE QUEUE
            const request = { socket, startTime };
            waitingQueue.push(request);

            // 3. AI FALLBACK
            setTimeout(() => {
                const index = waitingQueue.findIndex(r => r.socket.id === socket.id);
                if (index !== -1) {
                    waitingQueue.splice(index, 1);
                    const roomId = uuidv4();
                    socket.join(roomId);

                    // Mark room as AI
                    activeRooms.set(roomId, { type: 'ai' });

                    socket.emit('match_found', { roomId, opponent: 'ai' });
                }
            }, MATCH_DELAY);
        }
    });

    // --- NEW: CHAT AND PYTHON INTEGRATION ---
    socket.on('send_message', async (data) => {
        const { roomId, text } = data;
        const roomInfo = activeRooms.get(roomId);

        if (!roomInfo) return;

        // 1. Send the user's message to the room (so the frontend sees it)
        socket.to(roomId).emit('receive_message', { text: text, sender: 'them' });

        // 2. If it's an AI room, ask Python for a response
        if (roomInfo.type === 'ai') {
            try {
                // Call your Python FastAPI backend
                const response = await fetch(`${PYTHON_SERVICE_URL}/api/bot/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: text, session_id: roomId })
                });
                if (!response.ok) {
                    console.error("Python rejected request with status:", response.status);
                    return;
                }

                const botData = await response.json();
                console.log("Python Bot Response:", botData);
                // Simulate a little "typing" delay so the bot doesn't answer instantly
                setTimeout(() => {
                    socket.emit('receive_message', { text: botData.reply, sender: 'them' });
                }, 1500);

            } catch (error) {
                console.error("Python Bot Error:", error);
                socket.emit('receive_message', { text: "*System: Opponent disconnected.*", sender: 'system' });
            }
        }
    });

    socket.on('cancel_search', () => {
        const index = waitingQueue.findIndex(client => client.socket.id === socket.id);
        if (index !== -1) waitingQueue.splice(index, 1);
    });

    socket.on('leave_game', (roomId) => {
        socket.to(roomId).emit('opponent_left');
        socket.leave(roomId);
        activeRooms.delete(roomId); // Clean up memory
    });

    socket.on('disconnect', () => {
        // BUG FIX: Compare socket IDs, not the wrapper object
        waitingQueue = waitingQueue.filter(client => client.socket.id !== socket.id);
    });
});

app.post('/api/guess', (req, res) => {
    const { roomId, guess } = req.body; 
    const roomInfo = activeRooms.get(roomId);

    if (!roomInfo) {
        return res.status(404).json({ error: "Game session not found or already ended." });
    }

    const actualIdentity = roomInfo.type; // 'ai' or 'human'
    const isCorrect = actualIdentity.toLowerCase() === guess.toLowerCase();

    // 1. Initialize a counter if it doesn't exist
    if (!roomInfo.guessesCount) {
        roomInfo.guessesCount = 0;
    }

    // 2. Increment the counter for this room
    roomInfo.guessesCount++;

    // 3. Determine if we should delete the room yet
    // If it's an AI match, there's only 1 human, so delete immediately.
    // If it's a Human match, wait until the 2nd person has voted.
    if (roomInfo.type === 'ai' || roomInfo.guessesCount >= 2) {
        // Only delete once everyone is done
        activeRooms.delete(roomId);
    } else {
        // Notify the other human player that a guess was made
        // (This triggers their UI to show the 'Make Guess' buttons if they weren't already visible)
        io.to(roomId).emit('opponent_guessed');
    }

    res.json({
        success: true,
        isCorrect: isCorrect,
        actualIdentity: actualIdentity
    });
});
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Middleware listening on port ${PORT}`);
  console.log(`Connecting to AI at: ${PYTHON_SERVICE_URL}`);
});