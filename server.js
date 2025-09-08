import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pino from "pino";
import pinoPretty from "pino-pretty";
import WebSocket, { WebSocketServer } from "ws";

const USER_STATE_FILE = "./data/userState.json";

const app = express();
const logger = pino(pinoPretty());

app.use(cors());

app.use(
  bodyParser.json({
    type(req) {
      return true;
    },
  })
);

app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

let userState = [];

// Коллекция для хранения таймеров удаления пользователей
const deletionTimers = new Map();

// Загрузка userState из файла при запуске сервера
try {
  if (fs.existsSync(USER_STATE_FILE)) {
    const data = fs.readFileSync(USER_STATE_FILE, "utf-8");
    userState = JSON.parse(data);
    logger.info("Loaded userState from file");
  }
} catch (error) {
  logger.error("Error loading userState from file: " + error.message);
}

function saveUserState() {
  try {
    fs.writeFileSync(USER_STATE_FILE, JSON.stringify(userState, null, 2));
    logger.info("Saved userState to file");
  } catch (error) {
    logger.error("Error saving userState to file: " + error.message);
  }
}

// Функция для планирования удаления пользователя через 1 минуту
function scheduleDeletion(userId) {
  // Cancel any existing timer for this user
  if (deletionTimers.has(userId)) {
    clearTimeout(deletionTimers.get(userId));
  }
  // Set new timer
  deletionTimers.set(userId, setTimeout(() => {
    const idx = userState.findIndex(user => user.id === userId);
    if (idx !== -1) {
      userState.splice(idx, 1);
      saveUserState();
      logger.info(`User ${userId} deleted after 1 minute timeout`);
    }
    deletionTimers.delete(userId);
  }, 30000)); // 30 seconds
}

// Function to cancel deletion timer
function cancelDeletion(userId) {
  if (deletionTimers.has(userId)) {
    clearTimeout(deletionTimers.get(userId));
    deletionTimers.delete(userId);
    logger.info(`Deletion cancelled for user ${userId}`);
  }
}

// Track connected users by WebSocket connection
const connectedUsers = new Map();

app.post("/new-user", async (request, response) => {
  if (Object.keys(request.body).length === 0) {
    const result = {
      status: "error",
      message: "This name is already taken!",
    };
    response.status(400).send(JSON.stringify(result)).end();
  }

  const { name } = request.body;
  const isExist = userState.find((user) => user.name === name);

  if (!isExist) {
    const newUser = {
      id: randomUUID(),
      name: name,
    };

    userState.push(newUser);
    saveUserState();

    const result = {
      status: "ok",
      user: newUser,
    };

    logger.info(`New user created: ${JSON.stringify(newUser)}`);
    response.send(JSON.stringify(result)).end();
  } else {
    const result = {
      status: "error",
      message: "This name is already taken!",
    };

    logger.error(`User with name "${name}" already exist`);
    response.status(409).send(JSON.stringify(result)).end();
  }
});

const server = http.createServer(app);
const wsServer = new WebSocketServer({ server });
wsServer.on("connection", (ws) => {
  let currentUserId = null;

  ws.on("message", (msg, isBinary) => {
    const receivedMSG = JSON.parse(msg);

    logger.info(`Message received: ${JSON.stringify(receivedMSG)}`);

    // Set currentUserId if message has user
    if (receivedMSG.user && receivedMSG.user.id) {
      currentUserId = receivedMSG.user.id;
      // Cancel any pending deletion since user is active
      cancelDeletion(currentUserId);
    }

    // обработка выхода пользователя
    if (receivedMSG.type === "exit") {
      if (currentUserId) {
        scheduleDeletion(currentUserId);
        connectedUsers.delete(ws);
      }

      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(JSON.stringify(userState)));

      logger.info(`User exit scheduled for deletion: ${receivedMSG.user ? receivedMSG.user.name : 'unknown'}`);
      return;
    }

    // обработка отправки сообщения
    if (receivedMSG.type === "send") {
      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(msg, { binary: isBinary }));
      logger.info("Message sent to all users");
    }

    if (receivedMSG.type === "join") {
      if (receivedMSG.user) {
        currentUserId = receivedMSG.user.id;
        cancelDeletion(currentUserId);
        logger.info(`User joined: ${receivedMSG.user.name}`);
      }
    }
  });

  ws.on("close", () => {
    if (currentUserId) {
      scheduleDeletion(currentUserId);
      connectedUsers.delete(ws);
      logger.info(`User disconnected, deletion scheduled: ${currentUserId}`);

      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(JSON.stringify(userState)));
    }
  });

  [...wsServer.clients]
    .filter((o) => o.readyState === WebSocket.OPEN)
    .forEach((o) => o.send(JSON.stringify(userState)));
});

const port = process.env.PORT || 3000;

// Конечная точка API для проверки подлинности пользователя
app.post("/verify-user", (req, res) => {
  const { id, name } = req.body;
  const userExists = userState.some(
    (user) => user.id === id && user.name === name
  );
  if (userExists) {
    res.json({ status: "ok" });
  } else {
    res.status(404).json({ status: "error", message: "User not found" });
  }
});

const bootstrap = async () => {
  try {
    server.listen(port, () =>
      logger.info(`Server has been started on http://localhost:${port}`)
    );
  } catch (error) {
    logger.error(`Error: ${error.message}`);
  }
};

bootstrap();
