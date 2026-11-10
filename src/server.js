import { config } from './config.js';
import { createApp } from './app.js';
import { flushLengths } from './igrot/lengths.js';

createApp().listen(config.port, () => {
  console.log(`מכתבים לרבי – http://localhost:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushLengths(); process.exit(0); });
}
