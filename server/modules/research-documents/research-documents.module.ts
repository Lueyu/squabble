import { Module } from '@nestjs/common';
import { ResearchDocumentsService } from './research-documents.service';
import { ResearchDocumentsController } from './research-documents.controller';

@Module({ controllers: [ResearchDocumentsController], providers: [ResearchDocumentsService], exports: [ResearchDocumentsService] })
export class ResearchDocumentsModule {}
