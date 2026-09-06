import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors';
import { isTrue } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
  app.use(helmet());

  // Rate limiting is only meaningful if we can see the caller's real IP. Behind
  // a PaaS router that means trusting X-Forwarded-For — but trusting it when
  // *not* behind a proxy lets any client forge its own address, so this is
  // opt-in rather than on by default.
  if (isTrue(process.env.TRUST_PROXY)) {
    app.set('trust proxy', 1);
  }

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Same-origin in production, so CORS is only needed for the Vite dev server.
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin.split(','), credentials: true });
  }

  // Close the pool and drain in-flight requests on SIGTERM, which is how every
  // container runtime asks a process to stop.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on :${port} (${process.env.NODE_ENV ?? 'development'})`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
