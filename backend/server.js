const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const yahooFinance = require("yahoo-finance2").default;
const { Pool } = require("pg");
const cors = require("cors");
const os = require("os");
const nodemailer = require("nodemailer");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = 4000;

// ----- Postgres connection -----
const pool = new Pool({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "db",
  database: process.env.PGDATABASE || "streamsync",
  password: process.env.PGPASSWORD || "password",
  port: process.env.PGPORT || 5432,
});

// ----- Email transporter -----
const transporter = nodemailer.createTransport({
  service: "gmail", // or use SMTP service
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
    });
    console.log("📧 Email sent to", to);
  } catch (err) {
    console.error("Email error:", err);
  }
}

// ----- Save to DB -----
async function saveDatapoint(source, symbol, value) {
  try {
    await pool.query(
      "INSERT INTO datapoints (source, symbol, value) VALUES ($1, $2, $3)",
      [source, symbol, value]
    );
  } catch (err) {
    console.error("DB insert error:", err);
  }
}

// ----- Alert storage -----
let activeAlerts = {};

function checkAlerts(source, symbol, value) {
  const key = `${source}:${symbol}`;
  if (!activeAlerts[key]) return;

  activeAlerts[key] = activeAlerts[key].filter((alert) => {
    if (
      (alert.direction === "above" && value >= alert.value) ||
      (alert.direction === "below" && value <= alert.value)
    ) {
      if (alert.email) {
        sendEmail(
          alert.email,
          `StreamSync Alert: ${symbol}`,
          `${symbol} is now ${alert.direction === "above" ? "≥" : "≤"} ${
            alert.value
          }`
        );
      }
      io.emit("alertTriggered", {
        source,
        symbol,
        value,
        direction: alert.direction,
      });
      return false;
    }
    return true;
  });
}

// ----- Custom APIs -----
let customApis = [];

app.post("/register-api", (req, res) => {
  const { source, symbol, url, path } = req.body;
  if (!source || !symbol || !url || !path) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  customApis.push({ source, symbol, url, path });
  console.log("Registered custom API:", { source, symbol, url, path });
  res.json({ success: true });
});

// ----- Yahoo Finance -----
const FINANCE_SYMBOLS = ["AAPL", "MSFT", "GOOG", "BTC-USD", "ETH-USD"];

async function emitFinance() {
  try {
    const results = await yahooFinance.quote(FINANCE_SYMBOLS);
    for (const r of results) {
      const value =
        r.regularMarketPrice || r.postMarketPrice || r.preMarketPrice || null;
      if (value) {
        const payload = {
          source: "finance",
          symbol: r.symbol,
          value,
          timestamp: new Date(),
        };
        io.emit("dataUpdate", payload);
        await saveDatapoint("finance", r.symbol, value);
        checkAlerts("finance", r.symbol, value);
      }
    }
  } catch (err) {
    console.error("Yahoo Finance error:", err);
  }
}

// ----- Mock IoT -----
function emitIoT() {
  const sensors = ["TEMP_SENSOR", "HUMID_SENSOR"];
  sensors.forEach(async (s) => {
    const value =
      s === "TEMP_SENSOR" ? 20 + Math.random() * 5 : 50 + Math.random() * 10;
    const payload = { source: "iot", symbol: s, value, timestamp: new Date() };
    io.emit("dataUpdate", payload);
    await saveDatapoint("iot", s, value);
    checkAlerts("iot", s, value);
  });
}

// ----- Mock Weather -----
function emitWeather() {
  const cities = ["NYC_TEMP", "LA_TEMP"];
  cities.forEach(async (c) => {
    const value = 10 + Math.random() * 20;
    const payload = {
      source: "weather",
      symbol: c,
      value,
      timestamp: new Date(),
    };
    io.emit("dataUpdate", payload);
    await saveDatapoint("weather", c, value);
    checkAlerts("weather", c, value);
  });
}

// ----- System Metrics -----
function emitSystem() {
  const cpuLoad = os.loadavg()[0];
  const memUsage = (1 - os.freemem() / os.totalmem()) * 100;
  const metrics = [
    { symbol: "CPU_LOAD", value: cpuLoad },
    { symbol: "MEM_USAGE", value: memUsage },
  ];
  metrics.forEach(async (m) => {
    const payload = {
      source: "system",
      symbol: m.symbol,
      value: m.value,
      timestamp: new Date(),
    };
    io.emit("dataUpdate", payload);
    await saveDatapoint("system", m.symbol, m.value);
    checkAlerts("system", m.symbol, m.value);
  });
}

// ----- Custom -----
async function emitCustomApis() {
  for (const api of customApis) {
    try {
      const response = await axios.get(api.url);
      const value = api.path
        .split(".")
        .reduce((acc, key) => acc[key], response.data);

      const payload = {
        source: api.source,
        symbol: api.symbol,
        value,
        timestamp: new Date(),
      };
      io.emit("dataUpdate", payload);
      await saveDatapoint(api.source, api.symbol, value);
      checkAlerts(api.source, api.symbol, value);
    } catch (err) {
      console.error("Custom API error:", err.message);
    }
  }
}

// ----- REST API for history -----
app.get("/history/:source/:symbol", async (req, res) => {
  const { source, symbol } = req.params;
  const { range } = req.query;

  let interval = "30 minutes";
  if (range === "1h") interval = "1 hour";
  if (range === "12h") interval = "12 hours";
  if (range === "24h") interval = "24 hours";
  if (range === "3d") interval = "3 days";
  if (range === "7d") interval = "7 days";

  try {
    const result = await pool.query(
      `SELECT value, timestamp
       FROM datapoints
       WHERE source=$1 AND symbol=$2
         AND timestamp > NOW() - INTERVAL '${interval}'
       ORDER BY timestamp ASC`,
      [source, symbol]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("DB fetch error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ----- WebSocket scheduling -----
io.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("registerAlert", (alert) => {
    const key = `${alert.source}:${alert.symbol}`;
    if (!activeAlerts[key]) activeAlerts[key] = [];
    activeAlerts[key].push(alert);
    console.log("📌 Registered alert:", alert);
  });

  const financeInterval = setInterval(emitFinance, 5000);
  const iotInterval = setInterval(emitIoT, 7000);
  const weatherInterval = setInterval(emitWeather, 10000);
  const systemInterval = setInterval(emitSystem, 6000);
  const customInterval = setInterval(emitCustomApis, 8000);

  socket.on("disconnect", () => {
    clearInterval(financeInterval);
    clearInterval(iotInterval);
    clearInterval(weatherInterval);
    clearInterval(systemInterval);
    clearInterval(customInterval);
    console.log("Client disconnected");
  });
});

server.listen(PORT, () =>
  console.log(`Backend running on http://localhost:${PORT}`)
);
