-- Drop old table if it exists
DROP TABLE IF EXISTS prices;
DROP TABLE IF EXISTS datapoints;

-- New schema
CREATE TABLE datapoints (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,      -- e.g. 'finance', 'iot', 'weather', 'system'
  symbol TEXT NOT NULL,      -- e.g. 'AAPL', 'BTC-USD', 'TEMP_SENSOR'
  value NUMERIC NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW()
);
