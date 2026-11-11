import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { DataDatasetService } from '../data-library/data-dataset.service';
import { ResearchArtifactsController } from './research-artifacts.controller';
import { ResearchArtifactsService } from './research-artifacts.service';
import { PrivateArtifactStorage, RESEARCH_ARTIFACT_STORAGE } from './research-artifacts.storage';
import { ResearchDerivedCleanupService } from './research-derived-cleanup.service';

@Module({ controllers: [ResearchArtifactsController], providers: [DataDatasetService, ResearchArtifactsService, ResearchDerivedCleanupService,
  { provide: RESEARCH_ARTIFACT_STORAGE, useFactory: () => new PrivateArtifactStorage(
    process.env.RESEARCH_ARTIFACT_ROOT ?? resolve(process.cwd(), '.data', 'research-artifacts')) }],
  exports: [DataDatasetService, ResearchArtifactsService, ResearchDerivedCleanupService, RESEARCH_ARTIFACT_STORAGE] })
export class ResearchArtifactsModule {}
