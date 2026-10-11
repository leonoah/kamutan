import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Keep test output clean; the app's pino logger is configured with LOG_LEVEL=silent.
Logger.overrideLogger(false);
