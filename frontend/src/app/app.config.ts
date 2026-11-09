import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { environment } from '../environments/environment';
import { HttpBackend, apiKeyInterceptor } from './api.service';
import { BACKEND } from './backend';
import { BrowserBackend } from './demo/browser-backend';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptors([apiKeyInterceptor])),
    { provide: BACKEND, useFactory: () => (environment.demo ? inject(BrowserBackend) : inject(HttpBackend)) },
  ],
};
