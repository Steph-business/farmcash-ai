import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = config.get<number>('PORT') ?? 3000;
  const prefix = config.get<string>('API_PREFIX') ?? 'api';

  app.setGlobalPrefix(prefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  // Génère X-Request-Id en amont si le client n'en fournit pas
  app.use((req: any, res: any, next: () => void) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  });
  app.enableShutdownHooks();
  app.enableCors();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('FarmCash AI API')
    .setDescription(
      'Backend modulaire — chaque module peut être détaché en microservice',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .addTag('auth', 'Inscription, login OTP, gestion des sessions')
    .addTag('marketplace', 'Annonces, stocks, parcelles, cultures')
    .addTag('negotiation', 'Candidatures, contre-offres, contrats')
    .addTag('orders', 'Commandes, disputes, exports B2B')
    .addTag('finance', 'Wallets, paiements, escrow, payouts')
    .addTag('logistics', 'Shipments, tracking GPS')
    .addTag('messaging', 'Conversations, messages, notifications')
    .addTag('ai', 'Plant analyses, traitements, traçabilité')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${prefix}/docs`, app, document);

  await app.listen(port);
  logger.log(`API running on http://localhost:${port}/${prefix}`);
  logger.log(`Swagger docs on http://localhost:${port}/${prefix}/docs`);
}

bootstrap();
