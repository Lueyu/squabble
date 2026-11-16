/**
 * View module (SPA fallback).
 *
 * Registers `ViewController` only. Must be the last module imported in `AppModule`
 * so its catch-all routes (`/`, `*`) act as the frontend fallback and never
 * intercept `/api` calls.
 */
import { Module } from '@nestjs/common';
import { ViewController } from './view.controller';

/** View module definition: exposes the SPA shell controller. */
@Module({
  controllers: [ViewController],
  providers: [],
})
export class ViewModule {}
