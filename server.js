const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const connectDB = require('./config/db');
const { errorHandler } = require('./middlewares/errorMiddleware');
const { resetEngineCache } = require('./utils/verificationEngine');

dotenv.config();
const { requireIndusLicense } = require('./lib/indus_license');

const app = express();

app.use(
    helmet({
        contentSecurityPolicy: false,
    })
);
app.use(cors());
// A bulk run sends the parsed list (emails + original rows) to /api/verify/jobs.
// 500 rows of a wide spreadsheet is already ~120 KB, so the default 100 KB body
// limit rejects perfectly normal files.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/verify', require('./routes/verifyRoutes'));
app.use('/api/verification-settings', require('./routes/verificationSettingsRoutes'));
app.use('/api/reacher-backends', require('./routes/reacherRoutes'));
app.use('/api/history', require('./routes/historyRoutes'));

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

async function start() {
    await requireIndusLicense(__dirname);
    resetEngineCache();
    console.log('📦 Connecting to database...');
    await connectDB();

    // Server-side bulk runs keep going after the browser closes.
    require('./utils/jobRunner').start();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Open http://localhost:${PORT}`);
    });
}

start().catch(err => {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
});

process.on('SIGINT', () => {
    process.exit(0);
});
