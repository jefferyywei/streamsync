import { useEffect, useState } from "react";
import io from "socket.io-client";
import toast, { Toaster } from "react-hot-toast";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

const socket = io("http://localhost:4000");

type DataPoint = { time: string; value: number };
type AlertRule = {
  value: number;
  direction: "above" | "below";
  email?: string;
};

const AVAILABLE_STREAMS: Record<string, string[]> = {
  finance: ["AAPL", "MSFT", "GOOG", "BTC-USD", "ETH-USD"],
  iot: ["TEMP_SENSOR", "HUMID_SENSOR"],
  weather: ["NYC_TEMP", "LA_TEMP"],
  system: ["CPU_LOAD", "MEM_USAGE"],
};

const DEFAULT_STREAMS: Record<string, string> = {
  finance: "AAPL",
  iot: "TEMP_SENSOR",
  weather: "NYC_TEMP",
  system: "CPU_LOAD",
};

const CATEGORY_COLORS: Record<string, string> = {
  finance: "#3b82f6",
  iot: "#22c55e",
  weather: "#eab308",
  system: "#a855f7",
};

function round2(num: number): number {
  return Math.round(num * 100) / 100;
}

function App() {
  const [streams, setStreams] = useState<Record<string, string[]>>({
    finance: [DEFAULT_STREAMS.finance],
    iot: [DEFAULT_STREAMS.iot],
    weather: [DEFAULT_STREAMS.weather],
    system: [DEFAULT_STREAMS.system],
  });

  const [data, setData] = useState<Record<string, DataPoint[]>>({});
  const [alerts, setAlerts] = useState<Record<string, AlertRule>>({});
  const [ranges, setRanges] = useState<Record<string, string>>({});
  const [apiConfig, setApiConfig] = useState({
    source: "",
    symbol: "",
    url: "",
    path: "",
  });

  // ----- Fetch history -----
  async function fetchHistory(source: string, symbol: string, range = "30m") {
    try {
      const res = await fetch(
        `http://localhost:4000/history/${source}/${symbol}?range=${range}`
      );
      const hist = await res.json();
      setData((prev) => ({
        ...prev,
        [`${source}:${symbol}`]: hist.map((d: any) => ({
          time: new Date(d.timestamp).toLocaleTimeString("en-US", {
            hour12: true,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          value: round2(Number(d.value)),
          timestamp: new Date(d.timestamp).getTime(),
        })),
      }));
    } catch (err) {
      console.error("Error fetching history:", err);
    }
  }

  // ----- Initial history fetch when streams change -----
  useEffect(() => {
    Object.keys(streams).forEach((category) => {
      streams[category].forEach((symbol) => {
        const key = `${category}:${symbol}`;
        const range = ranges[key] || "30m";
        fetchHistory(category, symbol, range);
      });
    });
  }, [streams]);

  // ----- Refetch when user changes range -----
  useEffect(() => {
    Object.entries(ranges).forEach(([key, range]) => {
      const [category, symbol] = key.split(":");
      fetchHistory(category, symbol, range);
    });
  }, [ranges]);

  // ----- WebSocket handler -----
  useEffect(() => {
    const handler = (msg: any) => {
      const key = `${msg.source}:${msg.symbol}`;
      const timestamp = new Date(msg.timestamp);
      const newPoint = {
        time: timestamp.toLocaleTimeString("en-US", {
          hour12: true,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        value: round2(parseFloat(msg.value)),
        timestamp: timestamp.getTime(),
      };

      setData((prev) => {
        const series = prev[key] || [];
        const range = ranges[key] || "30m";

        // Calculate cutoff time based on range
        const now = Date.now();
        let cutoffTime = now - 30 * 60 * 1000;
        if (range === "1h") cutoffTime = now - 60 * 60 * 1000;
        else if (range === "12h") cutoffTime = now - 12 * 60 * 60 * 1000;
        else if (range === "24h") cutoffTime = now - 24 * 60 * 60 * 1000;
        else if (range === "3d") cutoffTime = now - 3 * 24 * 60 * 60 * 1000;
        else if (range === "7d") cutoffTime = now - 7 * 24 * 60 * 60 * 1000;

        const updatedSeries = [...series, newPoint];

        // Only filter if we have too many points to avoid constant recalculation
        if (updatedSeries.length > 1000) {
          const filteredSeries = updatedSeries.filter((point: any) => {
            if (!point.timestamp) return true;
            return point.timestamp >= cutoffTime;
          });
          return { ...prev, [key]: filteredSeries };
        }

        return { ...prev, [key]: updatedSeries };
      });

      // Alert check
      if (alerts[key]) {
        const { value, direction } = alerts[key];
        if (
          (direction === "above" && newPoint.value >= value) ||
          (direction === "below" && newPoint.value <= value)
        ) {
          toast.error(
            `${msg.symbol} ${direction === "above" ? "≥" : "≤"} ${value}`,
            { duration: 4000 }
          );
          setAlerts((prev) => {
            const updated = { ...prev };
            delete updated[key];
            return updated;
          });
        }
      }
    };

    socket.on("dataUpdate", handler);
    return () => {
      socket.off("dataUpdate", handler);
    };
  }, [alerts, ranges]);

  // ----- Add/Remove streams -----
  function addStream(category: string, symbol: string) {
    setStreams((prev) => {
      if (prev[category].includes(symbol)) return prev;
      return { ...prev, [category]: [...prev[category], symbol] };
    });
  }

  function removeStream(category: string, symbol: string) {
    setStreams((prev) => ({
      ...prev,
      [category]: prev[category].filter((s) => s !== symbol),
    }));
  }

  // ----- Register API -----
  async function registerApi() {
    try {
      await fetch("http://localhost:4000/register-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiConfig),
      });

      toast.success(`Registered API for ${apiConfig.symbol}`);

      // Auto-add new category + symbol to streams state
      setStreams((prev) => {
        const updated = { ...prev };
        if (!updated[apiConfig.source]) {
          updated[apiConfig.source] = [];
        }
        if (!updated[apiConfig.source].includes(apiConfig.symbol)) {
          updated[apiConfig.source].push(apiConfig.symbol);
        }
        return updated;
      });

      setApiConfig({ source: "", symbol: "", url: "", path: "" });
    } catch (err) {
      toast.error("Failed to register API");
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <Toaster position="top-right" reverseOrder={false} />
      <h1 className="text-3xl font-bold mb-6">StreamSync Dashboard</h1>

      {/* Register Custom API */}
      <div className="bg-gray-800 p-4 mb-6 rounded-lg">
        <h2 className="text-lg font-bold mb-2">Register Custom API</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <input
            type="text"
            placeholder="Source (e.g. custom)"
            value={apiConfig.source}
            onChange={(e) =>
              setApiConfig({ ...apiConfig, source: e.target.value })
            }
            className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
          />
          <input
            type="text"
            placeholder="Symbol (e.g. MY_API)"
            value={apiConfig.symbol}
            onChange={(e) =>
              setApiConfig({ ...apiConfig, symbol: e.target.value })
            }
            className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
          />
          <input
            type="text"
            placeholder="URL"
            value={apiConfig.url}
            onChange={(e) =>
              setApiConfig({ ...apiConfig, url: e.target.value })
            }
            className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
          />
          <input
            type="text"
            placeholder="Path (e.g. data.price)"
            value={apiConfig.path}
            onChange={(e) =>
              setApiConfig({ ...apiConfig, path: e.target.value })
            }
            className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
          />
        </div>
        <button
          onClick={registerApi}
          className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm"
        >
          Add API
        </button>
      </div>

      {Object.keys(streams).map((category) => (
        <div key={category} className="mb-10">
          <h2
            className="text-2xl font-bold mb-4 capitalize"
            style={{ color: CATEGORY_COLORS[category] || "#f97316" }}
          >
            {category}
          </h2>

          {/* Add stream dropdown (only for known categories) */}
          {AVAILABLE_STREAMS[category] && (
            <div className="flex gap-2 mb-4">
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    addStream(category, e.target.value);
                    e.target.value = "";
                  }
                }}
                className="px-3 py-2 rounded bg-gray-800 text-white"
                defaultValue=""
              >
                <option value="" disabled>
                  Add {category} stream...
                </option>
                {AVAILABLE_STREAMS[category].map((sym) => (
                  <option key={sym} value={sym}>
                    {sym}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Charts grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {streams[category].map((symbol) => {
              const key = `${category}:${symbol}`;
              const chartData = data[key] || [];
              const latest = chartData.at(-1)?.value ?? "—";
              const lineColor = CATEGORY_COLORS[category];

              // Calculate stable Y-axis domain
              const values = chartData
                .map((d) => d.value)
                .filter((v) => typeof v === "number");
              const minValue = values.length > 0 ? Math.min(...values) : 0;
              const maxValue = values.length > 0 ? Math.max(...values) : 100;
              const padding = (maxValue - minValue) * 0.1 || 1;
              const yDomain = [
                Math.max(0, minValue - padding),
                maxValue + padding,
              ];

              return (
                <div
                  key={key}
                  className="bg-gray-800 rounded-xl shadow-lg p-4 flex flex-col"
                >
                  <div className="flex justify-between mb-2">
                    <h3 className="font-semibold">{symbol}</h3>
                    <button
                      onClick={() => removeStream(category, symbol)}
                      className="text-red-400 hover:text-red-500"
                    >
                      ✕ Remove
                    </button>
                  </div>

                  {/* Latest + Range selector */}
                  <div className="flex items-center gap-4 mb-2 text-sm">
                    <span>
                      Latest:{" "}
                      {typeof latest === "number" ? latest.toFixed(2) : latest}
                    </span>
                    <select
                      value={ranges[key] || "30m"}
                      onChange={(e) =>
                        setRanges((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      className="px-2 py-1 rounded bg-gray-700 text-white text-xs"
                    >
                      <option value="30m">Last 30m</option>
                      <option value="1h">Last 1h</option>
                      <option value="12h">Last 12h</option>
                      <option value="24h">Last 24h</option>
                      <option value="3d">Last 3d</option>
                      <option value="7d">Last 7d</option>
                    </select>
                  </div>

                  {/* Alert controls */}
                  <div className="flex gap-2 mb-2">
                    <select
                      onChange={(e) =>
                        setAlerts((prev) => ({
                          ...prev,
                          [key]: {
                            ...(prev[key] || {}),
                            direction: e.target.value as "above" | "below",
                          },
                        }))
                      }
                      value={alerts[key]?.direction || "above"}
                      className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
                    >
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                    </select>

                    <input
                      type="number"
                      placeholder="Threshold"
                      className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const val = parseFloat(
                            (e.target as HTMLInputElement).value
                          );
                          if (!isNaN(val)) {
                            const rounded = round2(val);
                            const direction = alerts[key]?.direction || "above";
                            const email = alerts[key]?.email || "";

                            setAlerts((prev) => ({
                              ...prev,
                              [key]: {
                                value: rounded,
                                direction,
                                email,
                              },
                            }));

                            socket.emit("registerAlert", {
                              source: category,
                              symbol,
                              value: rounded,
                              direction,
                              email,
                            });

                            toast.success(
                              `Alert set for ${symbol} ${
                                direction === "below" ? "≤" : "≥"
                              } ${rounded.toFixed(2)} ${
                                email ? `(email: ${email})` : ""
                              }`
                            );
                            (e.target as HTMLInputElement).value = "";
                          }
                        }
                      }}
                    />

                    <input
                      type="email"
                      placeholder="Email"
                      className="px-2 py-1 rounded bg-gray-700 text-white text-sm"
                      onChange={(e) =>
                        setAlerts((prev) => ({
                          ...prev,
                          [key]: {
                            ...(prev[key] || {}),
                            email: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>

                  {/* Chart */}
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 12, fill: "#9ca3af" }}
                        tickFormatter={(value) => value}
                      />
                      <YAxis
                        domain={yDomain}
                        tickFormatter={(v) => v.toFixed(2)}
                        tick={{ fontSize: 12, fill: "#9ca3af" }}
                      />
                      <Tooltip
                        formatter={(val: number) => val.toFixed(2)}
                        contentStyle={{
                          backgroundColor: "#1f2937",
                          border: "none",
                          color: "#fff",
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke={lineColor}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default App;
