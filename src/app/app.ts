import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Public application root.
 *
 * It deliberately owns only the router outlet: the marketing landing and the
 * account ritual must be able to render without constructing the local-first
 * product, its repositories, or any background rhythm. Product chrome and
 * initialization live under the lazy ProductShell route.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
