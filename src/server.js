import { config } from './config.js';
import { createApp } from './app.js';

createApp().listen(config.port, () => {
  console.log(`מכתבים לרבי – http://localhost:${config.port}`);
});
