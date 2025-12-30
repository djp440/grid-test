import { GridContext } from "../src/logic/gridContext";
import { GridConfig, GridDirection } from "../src/types/grid";
import { logger } from "../src/utils/logger";
import * as fs from "fs";
import * as path from "path";

async function testGeometricGrid() {
  const config: GridConfig = {
    symbol: "SOL/USDT:USDT",
    direction: GridDirection.LONG,
    leverage: 10,
    lowerPrice: 100,
    upperPrice: 110,
    gridSpread: 0.01, // 1% spread
    quantityPerGrid: 1,
  };

  // Clean up previous test file
  const safeSymbol = config.symbol.replace(/[/:]/g, "_");
  const csvPath = path.join(
    process.cwd(),
    "temp",
    `grid_${safeSymbol}_${config.direction}.csv`
  );
  if (fs.existsSync(csvPath)) {
    fs.unlinkSync(csvPath);
  }

  logger.info("Testing Geometric Grid Calculation...");
  const ctx = new GridContext(config);
  // 假设 Tick Size 为 0.01
  await ctx.initialize(0.01);

  const levels = ctx.getLevels();
  logger.info(`Generated ${levels.length} levels.`);

  // Verify Levels align with Tick Size
  let allAligned = true;
  const tickSize = 0.01;
  const epsilon = 0.00000001;

  for (const level of levels) {
    const remainder = level.price % tickSize;
    // remainder should be close to 0 or close to tickSize
    const isAligned =
      remainder < epsilon || Math.abs(remainder - tickSize) < epsilon;

    if (!isAligned) {
      logger.error(
        `Level ${level.index} price ${level.price} is not aligned with tick size ${tickSize}`
      );
      allAligned = false;
    }
  }

  if (allAligned) {
    logger.info("SUCCESS: All grid levels are aligned with tick size.");
  } else {
    logger.error("FAILURE: Some grid levels are not aligned with tick size.");
  }

  // Verify Geometric Progression (Approximate)
  let isGeometric = true;
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1].price;
    const curr = levels[i].price;
    const ratio = (curr - prev) / prev;
    const expectedRatio = config.gridSpread;

    // Allow larger error due to rounding (approx tickSize / price)
    // For 100 price and 0.01 tick, error is roughly 0.0001
    if (Math.abs(ratio - expectedRatio) > 0.001) {
      logger.error(
        `Level ${i} ratio mismatch. Prev: ${prev}, Curr: ${curr}, Ratio: ${ratio}, Expected: ${expectedRatio}`
      );
      isGeometric = false;
    }
  }

  if (isGeometric) {
    logger.info(
      "SUCCESS: Grid levels follow approximate geometric progression."
    );
    // Print first few and last few
    logger.info("First 3 levels:");
    levels
      .slice(0, 3)
      .forEach(l => logger.info(`Index ${l.index}: ${l.price}`));
    logger.info("Last 3 levels:");
    levels.slice(-3).forEach(l => logger.info(`Index ${l.index}: ${l.price}`));
  } else {
    logger.error("FAILURE: Grid levels do not follow geometric progression.");
  }
}

testGeometricGrid();
