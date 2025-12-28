import fs from "fs";
import path from "path";
import chalk from "chalk";
import dayjs from "dayjs";

export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

interface LoggerConfig {
  console: boolean;
  file: boolean;
  dir: string;
  level: LogLevel;
}

export class Logger {
  private config: LoggerConfig;
  private logFilePath: string = "";

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      console: true,
      file: true,
      dir: "logs",
      level: LogLevel.INFO,
      ...config,
    };

    if (this.config.file) {
      this.initLogFile();
    }
  }

  private initLogFile() {
    if (!fs.existsSync(this.config.dir)) {
      fs.mkdirSync(this.config.dir, { recursive: true });
    }
    const filename = `bot_${dayjs().format("YYYY-MM-DD_HH-mm-ss")}.log`;
    this.logFilePath = path.join(this.config.dir, filename);
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    ...args: any[]
  ): string {
    const timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");
    const formattedArgs = args
      .map(arg => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        if (typeof arg === "object") {
          return JSON.stringify(arg);
        }
        return arg;
      })
      .join(" ");

    return `[${timestamp}] [${level}] ${message} ${formattedArgs}`;
  }

  public log(level: LogLevel, message: string, ...args: any[]) {
    const logMessage = this.formatMessage(level, message, ...args);

    // Console Output
    if (this.config.console) {
      let coloredMessage = logMessage;
      switch (level) {
        case LogLevel.INFO:
          coloredMessage = chalk.green(logMessage);
          break;
        case LogLevel.WARN:
          coloredMessage = chalk.yellow(logMessage);
          break;
        case LogLevel.ERROR:
          coloredMessage = chalk.red(logMessage);
          break;
      }
      console.log(coloredMessage);
    }

    // File Output
    if (this.config.file && this.logFilePath) {
      fs.appendFileSync(this.logFilePath, logMessage + "\n", {
        encoding: "utf8",
      });
    }
  }

  public info(message: string, ...args: any[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  public warn(message: string, ...args: any[]) {
    this.log(LogLevel.WARN, message, ...args);
  }

  public error(message: string, ...args: any[]) {
    this.log(LogLevel.ERROR, message, ...args);
  }
}

// 导出单例，方便全局使用，但也允许实例化新的 Logger
export const logger = new Logger();
