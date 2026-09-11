import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

/** Global: every module needs the database and none should re-import it. */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
