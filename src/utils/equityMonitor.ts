import * as fs from "fs";
import * as path from "path";
import { ExchangeManager } from "../exchange/exchangeManager";
import { ConfigLoader } from "../config/configLoader";
import { logger } from "./logger";
import dayjs from "dayjs";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { ChartConfiguration } from "chart.js";

export class EquityMonitor {
  private exchange: ExchangeManager;
  private dataDir: string;
  private outputDir: string;
  private csvPath: string;
  private imagePath: string;
  private chartService: ChartJSNodeCanvas;

  constructor() {
    this.exchange = ExchangeManager.getInstance();

    // 初始化路径
    this.dataDir = path.join(process.cwd(), "data");
    this.outputDir = path.join(process.cwd(), "output");
    this.csvPath = path.join(this.dataDir, "equity.csv");
    this.imagePath = path.join(this.outputDir, "equity.png");

    // 确保目录存在
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // 初始化 ChartJS
    // 宽 800px, 高 400px
    this.chartService = new ChartJSNodeCanvas({
      width: 800,
      height: 400,
      backgroundColour: "white",
    });
  }

  /**
   * 启动监控
   * 1. 立即执行一次记录
   * 2. 开启定时任务
   */
  public start() {
    const config = ConfigLoader.getInstance().getConfig();
    // 默认为 3600 秒
    const intervalSeconds = config.monitor?.interval_seconds || 3600;
    const intervalMs = intervalSeconds * 1000;

    logger.info(
      `[EquityMonitor] 启动权益监控服务，执行间隔: ${intervalSeconds} 秒`
    );

    // 立即执行一次
    this.recordAndPlot().catch(err => {
      logger.error(`[EquityMonitor] 首次记录失败: ${err.message}`);
    });

    // 定时执行
    setInterval(() => {
      this.recordAndPlot().catch(err => {
        logger.error(`[EquityMonitor] 定时记录失败: ${err.message}`);
      });
    }, intervalMs);
  }

  /**
   * 记录权益并绘图
   */
  private async recordAndPlot() {
    try {
      // 1. 获取当前权益
      const balance = await this.exchange.client.fetchBalance();
      const usdtEquity = balance.total["USDT"] || 0;
      const now = dayjs();
      const timestamp = now.format("YYYY-MM-DD HH:mm:ss");

      // 2. 写入 CSV
      this.appendToCsv(timestamp, usdtEquity);

      // 3. 读取 CSV 并生成图表
      await this.generateChart();

      logger.info(`[EquityMonitor] 记录权益成功: ${usdtEquity} USDT`);
    } catch (error: any) {
      logger.error(`[EquityMonitor] 执行出错: ${error.message}`);
    }
  }

  /**
   * 追加数据到 CSV
   */
  private appendToCsv(time: string, equity: number) {
    const header = "Time,Equity\n";
    const row = `${time},${equity}\n`;

    if (!fs.existsSync(this.csvPath)) {
      fs.writeFileSync(this.csvPath, header);
    }

    fs.appendFileSync(this.csvPath, row);
  }

  /**
   * 生成折线图
   */
  private async generateChart() {
    // 读取数据
    if (!fs.existsSync(this.csvPath)) return;

    const content = fs.readFileSync(this.csvPath, "utf-8");
    const lines = content.split("\n").filter(line => line.trim() !== "");

    // 解析 CSV (跳过 header)
    const labels: string[] = [];
    const dataPoints: number[] = [];

    // 从第1行开始 (索引0是header)
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length >= 2) {
        // 简化时间标签，只显示 MM-DD HH:mm
        labels.push(dayjs(parts[0]).format("MM-DD HH:mm"));
        dataPoints.push(parseFloat(parts[1]));
      }
    }

    if (dataPoints.length === 0) return;

    // 配置图表
    const configuration: ChartConfiguration = {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "USDT Equity",
            data: dataPoints,
            borderColor: "rgb(75, 192, 192)",
            backgroundColor: "rgba(75, 192, 192, 0.2)",
            tension: 0.1,
            fill: true,
          },
        ],
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: "Account Equity History",
          },
          legend: {
            display: true,
          },
        },
        scales: {
          y: {
            beginAtZero: false, // 权益曲线通常不需要从0开始，这样更能看清波动
          },
        },
      },
    };

    // 生成 Buffer
    const imageBuffer = await this.chartService.renderToBuffer(configuration);

    // 写入文件
    fs.writeFileSync(this.imagePath, imageBuffer);
  }
}
