import { Mutex } from "async-mutex";
import { ExchangeManager } from "../exchange/exchangeManager";
import { OrderExecutor } from "../exchange/orderExecutor";
import { GridContext } from "./gridContext";
import { ConfigLoader } from "../config/configLoader";
import { logger } from "../utils/logger";
import { GridDirection } from "../types/grid";
import * as readline from "readline";

/**
 * BotEngine 核心引擎
 * 负责管理网格策略的生命周期，处理 WebSocket 事件驱动逻辑
 */
export class BotEngine {
  private exchange: ExchangeManager;
  private executor: OrderExecutor;
  private gridContexts: GridContext[] = [];
  private isRunning: boolean = false;
  // 记录每个策略当前的锚点索引 (Anchor Index)
  private anchorIndices: Record<string, number> = {};
  // 记录每个策略上次锚点重置的时间戳，用于冷却
  private lastAnchorResetTime: Record<string, number> = {};
  // 记录每个策略是否因为“无仓位”而暂时禁用了平仓挂单
  private isCloseDisabled: Record<string, boolean> = {};
  // 策略互斥锁，防止并发同步导致的重复挂单
  private stratLocks: Record<string, Mutex> = {};

  // 辅助函数：生成策略的唯一标识 Key
  private getStratKey(symbol: string, direction: GridDirection): string {
    return `${symbol}_${direction}`;
  }

  /**
   * 获取或创建策略锁
   */
  private getLock(stratKey: string): Mutex {
    if (!this.stratLocks[stratKey]) {
      this.stratLocks[stratKey] = new Mutex();
    }
    return this.stratLocks[stratKey];
  }

  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.executor = new OrderExecutor();
  }

  /**
   * 交互式确认
   */
  private async askConfirmation(message: string): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise(resolve => {
      rl.question(`${message} (Y/N): `, answer => {
        rl.close();
        resolve(answer.trim().toUpperCase() === "Y");
      });
    });
  }

  /**
   * 检查并自动构建底仓
   */
  private async checkAndBuildInitialPosition(ctx: GridContext): Promise<void> {
    const appConfig = ConfigLoader.getInstance().getConfig();
    if (!appConfig.default.auto_initial_position) return;

    const config = ctx.getConfig();

    // Check existing position
    try {
      const positions = await this.exchange.client.fetchPositions([
        config.symbol,
      ]);
      const targetSide =
        config.direction === GridDirection.LONG ? "long" : "short";
      const existingPosition = positions.find(
        (p: any) => p.symbol === config.symbol && p.side === targetSide
      );

      if (existingPosition && existingPosition.contracts > 0) {
        logger.info(
          `[BotEngine] [${config.symbol}] [AutoInit] 检测到已有 ${targetSide} 仓位 (${existingPosition.contracts})，跳过自动建仓`
        );
        return;
      }
    } catch (e: any) {
      logger.warn(
        `[BotEngine] [${config.symbol}] [AutoInit] 检查持仓失败，跳过自动建仓: ${e.message}`
      );
      return;
    }

    const ticker = await this.exchange.client.fetchTicker(config.symbol);
    const currentPrice = ticker.last;

    // Calculate required position
    const levels = ctx.getLevels();
    let requiredQty = 0;

    if (config.direction === GridDirection.LONG) {
      // LONG: 价格 > 当前价的部分需要有持仓才能挂卖单
      for (const level of levels) {
        if (level.price > currentPrice) {
          requiredQty += config.quantityPerGrid;
        }
      }
    } else {
      // SHORT: 价格 < 当前价的部分需要有空单持仓才能挂买单(平空)
      for (const level of levels) {
        if (level.price < currentPrice) {
          requiredQty += config.quantityPerGrid;
        }
      }
    }

    if (requiredQty <= 0) return;

    logger.info(
      `[BotEngine] [${config.symbol}] [AutoInit] 需建仓数量: ${requiredQty}`
    );

    // Check Equity
    const balance = await this.exchange.client.fetchBalance();
    const equity = balance["USDT"]
      ? balance["USDT"].total
      : balance.total["USDT"] || 0;

    const leverage = config.leverage || 1;
    const positionValue = requiredQty * currentPrice;
    // 阈值: (权益 * 杠杆) / 2
    const threshold = (equity * leverage) / 2;

    if (positionValue > threshold) {
      logger.warn(
        `[BotEngine] [${
          config.symbol
        }] [AutoInit] 警告: 所需仓位价值 (${positionValue.toFixed(
          2
        )}) 超过账户权益*杠杆的一半 (${threshold.toFixed(2)})`
      );
      const confirm = await this.askConfirmation(
        `确认要继续市价建仓吗? 数量: ${requiredQty}, 预计花费: ${positionValue.toFixed(
          2
        )} USDT`
      );
      if (!confirm) {
        logger.info(`[BotEngine] 用户取消建仓，停止运行`);
        process.exit(0);
      }
    }

    // Execute Market Order
    logger.info(
      `[BotEngine] [${config.symbol}] [AutoInit] 正在执行市价建仓...`
    );
    try {
      const side = config.direction === GridDirection.LONG ? "buy" : "sell";
      await this.executor.placeMarketOrder(config.symbol, side, requiredQty);
      logger.info(`[BotEngine] [${config.symbol}] [AutoInit] 市价建仓完成`);
    } catch (e: any) {
      logger.error(
        `[BotEngine] [${config.symbol}] [AutoInit] 建仓失败: ${e.message}`
      );
      throw e;
    }
  }

  /**
   * 启动引擎
   */
  public async start(): Promise<void> {
    try {
      logger.info("[BotEngine] 正在启动引擎...");

      // 1. 初始化交易所连接
      await this.exchange.initConnection();

      // 2. 加载网格配置
      const config = ConfigLoader.getInstance().getConfig();

      // 为每个启用的策略初始化 GridContext
      for (const strat of config.strategies) {
        // 获取 Tick Size
        const tickSize = this.exchange.getTickSize(strat.symbol);
        logger.info(`[BotEngine] [${strat.symbol}] Tick Size: ${tickSize}`);

        const ctx = new GridContext(strat);
        await ctx.initialize(tickSize);
        this.gridContexts.push(ctx);

        // 检查并自动构建底仓
        await this.checkAndBuildInitialPosition(ctx);

        // 初始挂单同步
        await this.initialPositioning(ctx);
      }

      this.isRunning = true;
      logger.info("[BotEngine] 引擎启动成功，开始监听市场事件...");
      // 3. 启动事件监听循环 (不阻塞)
      this.watchOrdersLoop();
      // 为每个策略启动独立的并行价格监听协程
      for (const ctx of this.gridContexts) {
        this.watchTickerLoop(ctx).catch(e => {
          logger.error(
            `[BotEngine] [${ctx.getConfig().symbol}] 价格监听协程崩溃: ${
              e.message
            }`
          );
        });
      }
    } catch (error: any) {
      logger.error(`[BotEngine] 启动失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 初始挂单：根据当前价格挂出第一组单
   */
  private async initialPositioning(ctx: GridContext): Promise<void> {
    const config = ctx.getConfig();
    const ticker = await this.exchange.client.fetchTicker(config.symbol);
    const currentPrice = ticker.last;

    logger.info(
      `[BotEngine] [${config.symbol}] 初始价格: ${currentPrice}，正在寻找初始锚点...`
    );

    const nearest = ctx.getNearestLevels(currentPrice);
    if (!nearest) {
      logger.warn(`[BotEngine] [${config.symbol}] 初始价格超出网格范围`);
      return;
    }

    // 初始锚点设为当前最接近的下边界索引
    const stratKey = this.getStratKey(config.symbol, config.direction);
    this.anchorIndices[stratKey] = nearest[0].index;
    await this.refreshGridOrdersByAnchor(ctx);
  }

  /**
   * 核心逻辑：基于锚点索引 (Anchor Index) 刷新挂单
   */
  private async refreshGridOrdersByAnchor(ctx: GridContext): Promise<void> {
    const config = ctx.getConfig();
    const stratKey = this.getStratKey(config.symbol, config.direction);

    // 使用互斥锁确保同一策略不会并发执行同步
    const release = await this.getLock(stratKey).acquire();

    try {
      let retrySync = true;
      while (retrySync) {
        retrySync = false;
        const anchorIndex = this.anchorIndices[stratKey];
        const levels = ctx.getLevels();

        if (anchorIndex === undefined) break;

        // 1. 计算挂单窗口
        const appConfig = ConfigLoader.getInstance().getConfig();
        const windowSize = appConfig.default.order_window || 1;
        const targets = [];

        // 下方挂单窗口 (买单区)
        for (let i = 1; i <= windowSize; i++) {
          const idx = anchorIndex - i;
          if (idx < 0) break;

          targets.push({
            price: levels[idx].price,
            amount: config.quantityPerGrid,
            action:
              config.direction === GridDirection.LONG
                ? ("open" as const)
                : ("close" as const),
          });
        }

        // 上方挂单窗口 (卖单区)
        for (let i = 1; i <= windowSize; i++) {
          const idx = anchorIndex + i;
          if (idx >= levels.length) break;

          const isLongClose = config.direction === GridDirection.LONG;
          if (isLongClose && this.isCloseDisabled[stratKey]) {
            continue;
          }

          targets.push({
            price: levels[idx].price,
            amount: config.quantityPerGrid,
            action: isLongClose ? ("close" as const) : ("open" as const),
          });
        }

        // 下方挂单窗口中的平仓单 (SHORT 策略) 过滤
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          if (
            config.direction === GridDirection.SHORT &&
            t.action === "close"
          ) {
            if (this.isCloseDisabled[stratKey]) {
              targets.splice(i, 1);
              i--;
            }
          }
        }

        logger.info(
          `[BotEngine] [${config.symbol}] [${config.direction}] 锚点: ${anchorIndex} (${levels[anchorIndex].price}) | 执行同步...`
        );

        try {
          await this.executor.syncActiveOrders(
            config.symbol,
            config.direction,
            targets
          );
        } catch (error: any) {
          if (error.code === "NO_POSITION") {
            logger.warn(
              `[BotEngine] [${config.symbol}] [${config.direction}] 检测到无仓位平仓报错，暂时禁用平仓挂单并重试`
            );
            this.isCloseDisabled[stratKey] = true;
            retrySync = true; // 循环重试，避免递归导致的死锁
          } else {
            throw error;
          }
        }
      }
    } finally {
      release();
    }
  }

  /**
   * WebSocket 订单监听循环
   */
  private async watchOrdersLoop(): Promise<void> {
    logger.info("[BotEngine] 启动 watchOrders 监听任务...");

    // 显式激活每个 symbol 的订单订阅
    for (const ctx of this.gridContexts) {
      const symbol = ctx.getConfig().symbol;
      this.exchange.client.watchOrders(symbol).catch((e: any) => {
        logger.error(`[BotEngine] 订阅 ${symbol} 订单失败: ${e.message}`);
      });
    }

    while (this.isRunning) {
      try {
        // 监听订单更新
        const orders = await this.exchange.client.watchOrders();

        if (!orders || orders.length === 0) continue;

        for (const order of orders) {
          // 增加调试日志，捕获所有状态变更
          logger.info(
            `[Debug] 收到订单推送: ${order.symbol} | ID: ${order.id} | 状态: ${order.status} | 成交量: ${order.filled}/${order.amount}`
          );

          // 处理已成交 (filled) 或 部分成交且已关闭 的订单
          const isFilled = order.status === "filled";
          const isPartiallyFilledClosed =
            order.status === "closed" && order.filled > 0;

          if (!isFilled && !isPartiallyFilledClosed) continue;

          // 1. 查找该 symbol 下的所有相关策略 (联动响应)
          const relatedContexts = this.gridContexts.filter(
            c => c.getConfig().symbol === order.symbol
          );
          if (relatedContexts.length === 0) continue;

          logger.info(
            `[BotEngine] 确认成交: ${order.symbol} | ${order.side} | 价格: ${
              order.average || order.price
            } | 状态: ${order.status} | 联动刷新策略数: ${
              relatedContexts.length
            }`
          );

          // 2. 确定锚定参考价
          const appConfig = ConfigLoader.getInstance().getConfig();
          let referencePrice = order.price;

          // 如果开启了跟随市价，则尝试获取最新 Ticker 价格作为锚定基准
          if (appConfig.default.follow_market_on_fill) {
            try {
              const ticker = await this.exchange.client.fetchTicker(
                order.symbol
              );
              referencePrice = ticker.last;
              logger.info(
                `[BotEngine] [${order.symbol}] 开启成交联动跟随，锚定基准: 成交价 ${order.price} -> 最新价 ${referencePrice}`
              );
            } catch (e) {
              logger.warn(
                `[BotEngine] 获取最新价失败，回退到成交价锚定: ${order.price}`
              );
            }
          }

          // 3. 并发刷新所有相关策略
          await Promise.all(
            relatedContexts.map(async ctx => {
              const config = ctx.getConfig();
              const stratKey = this.getStratKey(
                config.symbol,
                config.direction
              );

              const nearest = ctx.getNearestLevels(referencePrice);
              if (nearest) {
                const newAnchor =
                  Math.abs(nearest[0].price - referencePrice) <
                  Math.abs(nearest[1].price - referencePrice)
                    ? nearest[0].index
                    : nearest[1].index;

                // 更新锚点（引入利润保护约束）
                const oldAnchor = this.anchorIndices[stratKey];
                let finalAnchor = newAnchor;

                // 只有触发成交的那个策略才需要利润保护约束（防止 0 利润挂单）
                const isTriggeringStrat =
                  (order.side === "buy" &&
                    config.direction === GridDirection.LONG) ||
                  (order.side === "sell" &&
                    config.direction === GridDirection.SHORT);

                if (isTriggeringStrat) {
                  const filledNearest = ctx.getNearestLevels(order.price);
                  if (filledNearest) {
                    const filledIdx =
                      Math.abs(filledNearest[0].price - order.price) <
                      Math.abs(filledNearest[1].price - order.price)
                        ? filledNearest[0].index
                        : filledNearest[1].index;

                    // 获取订单的 tradeSide (开/平)
                    const tradeSide = order.info.tradeSide;

                    if (tradeSide === "open") {
                      if (config.direction === GridDirection.LONG) {
                        // 开多后，锚点不能低于买入位，确保平多单在上方
                        finalAnchor = Math.max(newAnchor, filledIdx);
                      } else {
                        // 开空后，锚点不能高于卖出位，确保平空单在下方
                        finalAnchor = Math.min(newAnchor, filledIdx);
                      }
                    }
                  }
                }

                this.anchorIndices[stratKey] = finalAnchor;

                // 只有当锚点确实发生了位移，或者正是成交方，才执行同步操作
                if (newAnchor !== oldAnchor || isTriggeringStrat) {
                  logger.info(
                    `[BotEngine] [${config.symbol}] [${config.direction}] 联动更新锚点: ${oldAnchor} -> ${newAnchor}`
                  );

                  // 如果有成交，说明可能产生了新仓位，重置平仓禁用状态
                  if (isTriggeringStrat && this.isCloseDisabled[stratKey]) {
                    this.isCloseDisabled[stratKey] = false;
                  }

                  await this.refreshGridOrdersByAnchor(ctx);
                }
              }
            })
          );
        }
      } catch (error: any) {
        logger.error(`[BotEngine] watchOrders 异常: ${error.message}`);
        // 避免死循环瞬间消耗 CPU，等待一秒后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * 并行价格监听循环：每个策略独立运行，实现积极锚点追随
   */
  private async watchTickerLoop(ctx: GridContext): Promise<void> {
    const appConfig = ConfigLoader.getInstance().getConfig();
    // 如果开启了自动建仓模式，则禁用锚点重置特性
    if (appConfig.default.auto_initial_position) {
      logger.info(
        `[BotEngine] [${
          ctx.getConfig().symbol
        }] 自动建仓模式已开启，禁用锚点重置监听`
      );
      return;
    }

    const config = ctx.getConfig();
    const stratKey = this.getStratKey(config.symbol, config.direction);

    while (this.isRunning) {
      try {
        const ticker = await this.exchange.client.watchTicker(config.symbol);
        const currentPrice = ticker.last;

        const anchorIdx = this.anchorIndices[stratKey];
        if (anchorIdx === undefined) continue;

        const levels = ctx.getLevels();
        const anchorPrice = levels[anchorIdx].price;
        const gridDiff = levels[1].price - levels[0].price;

        /**
         * 积极追随逻辑：
         * 防止价格在网格间隙中大幅波动而没有触发订单（例如跳空或订单未成交）。
         *
         * 修正：
         * 1. 动态计算当前价格附近的 gridDiff (等比网格中，高价位的 gridDiff 比低价位大)。
         * 2. 增加阈值到 2.0 倍 gridDiff，避免在网格边缘频繁震荡。
         * 3. 增加时间冷却 (Cooldown)，避免短时间内连续重置。
         */

        // 动态获取当前锚点附近的网格间距
        let currentGridDiff = 0;
        if (anchorIdx < levels.length - 1) {
          currentGridDiff =
            levels[anchorIdx + 1].price - levels[anchorIdx].price;
        } else if (anchorIdx > 0) {
          currentGridDiff =
            levels[anchorIdx].price - levels[anchorIdx - 1].price;
        } else {
          // Fallback (极少情况)
          currentGridDiff = levels[1].price - levels[0].price;
        }

        // 阈值设为 2 倍间距，提供足够的缓冲区
        const threshold = currentGridDiff * 2.0;

        if (Math.abs(currentPrice - anchorPrice) > threshold) {
          // 检查冷却时间 (5秒)
          const now = Date.now();
          const lastReset = this.lastAnchorResetTime[stratKey] || 0;
          if (now - lastReset < 5000) {
            continue;
          }

          const nearest = ctx.getNearestLevels(currentPrice);
          if (nearest) {
            // 选取最接近当前价格的刻度作为新锚点
            const newAnchor =
              Math.abs(nearest[0].price - currentPrice) <
              Math.abs(nearest[1].price - currentPrice)
                ? nearest[0].index
                : nearest[1].index;

            if (newAnchor !== anchorIdx) {
              logger.info(
                `[BotEngine] [${config.symbol}] [${
                  config.direction
                }] 价格漂移 (${currentPrice})，积极重置锚点: ${anchorIdx} -> ${newAnchor} (Diff: ${currentGridDiff.toFixed(
                  4
                )}, Thr: ${threshold.toFixed(4)})`
              );
              this.anchorIndices[stratKey] = newAnchor;
              this.lastAnchorResetTime[stratKey] = now;
              await this.refreshGridOrdersByAnchor(ctx);
            }
          }
        }
      } catch (error: any) {
        logger.error(
          `[BotEngine] [${config.symbol}] watchTicker 异常: ${error.message}`
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * 停止引擎
   */
  /**
   * 停止引擎并根据配置执行清理
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    logger.info("[BotEngine] 引擎正在停止，开始执行清理逻辑...");

    const appConfig = ConfigLoader.getInstance().getConfig();
    const processedSymbols = new Set<string>();

    for (const ctx of this.gridContexts) {
      const symbol = ctx.getConfig().symbol;
      if (processedSymbols.has(symbol)) continue;

      // 1. 自动撤单
      if (appConfig.default.cancel_all_on_stop) {
        await this.executor.cancelAllOrders(symbol);
      }

      // 2. 自动平仓
      if (appConfig.default.close_all_on_stop) {
        await this.executor.flashClosePositions(symbol);
      }

      processedSymbols.add(symbol);
    }

    logger.info("[BotEngine] 清理逻辑执行完毕，引擎已关闭");
  }
}
