import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';
import { ChannelMemoryService } from './channel-memory.service';
import { ChannelBriefsService } from './channel-briefs.service';

@Module({ imports: [QuoteModule], controllers: [ChannelController], providers: [ChannelService, ChannelMemoryService, ChannelBriefsService], exports: [ChannelService, ChannelMemoryService, ChannelBriefsService] })
export class ChannelModule {}
