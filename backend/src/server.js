const config = require('./config');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const webhookRoutes = require('./routes/webhooks');
const deliveryRoutes = require('./routes/deliveries');

const app = express();

// CORS
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow frontend origin and any localhost
    if (origin === config.FRONTEND_ORIGIN || origin.match(/^http:\/\/localhost:\d+$/)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/projects', deliveryRoutes);

// Start
app.listen(config.PORT, () => {
  console.log(`NIPC Portal backend listening on port ${config.PORT}`);
  console.log(`CORS origin: ${config.FRONTEND_ORIGIN}`);
});
