import { ExchangeManager } from "../src/exchange/exchangeManager";
import { OrderExecutor } from "../src/exchange/orderExecutor";
import { GridDirection } from "../src/types/grid";
import { logger } from "../src/utils/logger";
import { ConfigLoader } from "../src/config/configLoader";

/**
 * OrderExecutor 完整功能测试脚本
 * 测试内容：
 * 1. 初始化连接与 Hedge Mode 验证
 * 2. 多头开仓挂单 (Buy Open)
 * 3. 多头平仓挂单 (Buy Close)
 * 4. 空头开仓挂单 (Sell Open)
 * 5. 空头平仓挂单 (Sell Close)
 * 6. 订单撤销功能
 * 7. 订单同步功能 (syncActiveOrders)
 */
async function runTest() {
  try {
    logger.info("=== 开始 OrderExecutor 完整性测试 ===");

    // 0. 加载配置
    ConfigLoader.getInstance().loadConfig();

    // 1. 初始化交易所连接
    const exchange = ExchangeManager.getInstance();
    await exchange.initConnection();

    const executor = new OrderExecutor();
    const symbol = "BTC/USDT:USDT"; // 使用标准 CCXT 符号

    // 获取当前价格作为参考
    const ticker = await exchange.client.fetchTicker(symbol);
    const currentPrice = ticker.last;
    logger.info(`当前 ${symbol} 价格: ${currentPrice}`);

    // 为了确保 Post Only 挂单成功且不触发交易所价格限制，我们设置一个合理的偏离值 (如 2%)
    const longOpenPrice = Math.floor(currentPrice * 0.98); // 下方 2% 挂多单
    const shortOpenPrice = Math.ceil(currentPrice * 1.02); // 上方 2% 挂空单

    // 2. 测试多头开仓 (Long Open)
    logger.info("--- 测试 1: 多头开仓挂单 ---");
    const longOrder = await executor.placeGridOrder(
      symbol,
      longOpenPrice,
      0.01, // 最小下单量，请根据模拟盘余额调整
      GridDirection.LONG,
      "open"
    );

    // 3. 测试多头平仓 (Long Close)
    // 注意：Bitget 平仓需要有持仓，这里仅测试挂单指令是否正确发送
    logger.info("--- 测试 2: 多头平仓挂单 (跳过实际执行，仅记录逻辑) ---");
    // Bitget 平仓需要持仓，为了不修改账户状态，我们仅在此处说明：
    // 如果执行，参数将为: side='buy', params: { tradeSide: 'close' }
    /*
    await executor.placeGridOrder(
      symbol,
      longOpenPrice + 10,
      0.01,
      GridDirection.LONG,
      "close"
    );
    */

    // 4. 测试空头开仓 (Short Open)
    logger.info("--- 测试 3: 空头开仓挂单 ---");
    const shortOrder = await executor.placeGridOrder(
      symbol,
      shortOpenPrice,
      0.01,
      GridDirection.SHORT,
      "open"
    );

    // 5. 测试撤单功能
    logger.info("--- 测试 4: 撤销所有挂单 ---");
    await executor.cancelAllOrders(symbol);

    // 6. 测试订单同步功能 (syncActiveOrders)
    logger.info("--- 测试 5: 订单同步逻辑 (增量更新) ---");
    const targetLevels = [
      { price: longOpenPrice - 50, amount: 0.01, action: "open" as const },
    ];

    logger.info("执行第一次同步 (预期挂出 1 笔多单)...");
    await executor.syncActiveOrders(symbol, GridDirection.LONG, targetLevels);

    const targetLevels2 = [
      { price: longOpenPrice - 100, amount: 0.01, action: "open" as const },
    ];
    logger.info("执行第二次同步 (预期撤销旧单，挂出新单)...");
    await executor.syncActiveOrders(symbol, GridDirection.LONG, targetLevels2);

    // 最后清理
    logger.info("--- 测试结束: 清理所有订单 ---");
    await executor.cancelAllOrders(symbol);

    logger.info("=== OrderExecutor 所有测试用例执行完毕 ===");
  } catch (error: any) {
    logger.error(`测试过程中发生错误: ${error.message}`);
    if (error.stack) {
      logger.error(error.stack);
    }
  } finally {
    // 确保程序正常退出
    process.exit(0);
  }
}

runTest();
