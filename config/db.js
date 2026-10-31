
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod = null;
let dbReady = false;

const connectDB = async () => {
    if (process.env.MONGO_URI) {
        try {
            const conn = await mongoose.connect(process.env.MONGO_URI, {
                serverSelectionTimeoutMS: 15000,
            });

            dbReady = true;
            console.log(`✅ Persistent MongoDB Connected: ${conn.connection.host}`);
            return;
        } catch (error) {
            console.error(`❌ Persistent MongoDB connection failed: ${error.message}`);
            throw error;
        }
    }

    if (process.env.NODE_ENV === 'production') {
        throw new Error('MONGO_URI is required in production. Refusing temporary database.');
    }

    try {
        mongod = await MongoMemoryServer.create({
            instance: { ip: '127.0.0.1' },
        });

        const conn = await mongoose.connect(mongod.getUri(), {
            serverSelectionTimeoutMS: 10000,
        });

        dbReady = true;
        console.log(`✅ Development MongoDB ready: ${conn.connection.host}`);
    } catch (error) {
        console.error(`❌ MongoDB failed: ${error.message}`);
        throw error;
    }
};

function isDbReady() {
    return dbReady && mongoose.connection.readyState === 1;
}

process.on('SIGINT', async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
    process.exit(0);
});

module.exports = connectDB;
module.exports.isDbReady = isDbReady;
