import { Module } from '@nestjs/common';
import { ErpClient, HTTP_FETCH, type FetchFn } from './erp-client.js';

@Module({
  providers: [ErpClient, { provide: HTTP_FETCH, useValue: ((...args) => fetch(...args)) satisfies FetchFn }],
  exports: [ErpClient],
})
export class ErpClientModule {}
