import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from './channels/channel';
import { ConsoleChannel } from './channels/console.channel';
import { WhatsAppChannel } from './channels/whatsapp.channel';
import { NotificationsController } from './notifications.controller';
import { NotificationsScheduler } from './notifications.scheduler';
import { NotificationsService } from './notifications.service';

/** Global: bookings, cancellations and payments all queue messages. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsScheduler,
    WhatsAppChannel,
    ConsoleChannel,
    {
      // A configured provider wins. Without one, messages are logged rather
      // than silently dropped — and in production the console channel says
      // loudly that nothing was delivered.
      provide: NOTIFICATION_CHANNEL,
      inject: [WhatsAppChannel, ConsoleChannel, ConfigService],
      useFactory: (
        whatsapp: WhatsAppChannel,
        consoleChannel: ConsoleChannel,
        config: ConfigService,
      ): NotificationChannel => {
        if (whatsapp.configured) return whatsapp;
        if (config.get<string>('NODE_ENV') === 'production') {
          new Logger('Notifications').warn(
            'No messaging provider configured; customer messages will not be delivered.',
          );
        }
        return consoleChannel;
      },
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
