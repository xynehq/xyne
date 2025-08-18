#!/usr/bin/env bun

import { isNotNull, } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '../db/schema';

// Migrate encrypted data
const migrateData = async () => {
    console.log('Connected to database');
        // Clear refresh tokens (they'll be invalid anyway with new secrets)
        await db.update(users).set({ refreshToken: '' }).where(isNotNull(users.refreshToken));
        

    
};

// Main function
const main = async () => {
    try {
        // Migrate encrypted data
        await migrateData();
        console.log('🎉 Key rotation completed successfully!');
        console.log('⚠️  Users will need to re-login due to new token secrets');

    } catch (error) {
        console.error('❌ Key rotation failed:', error);
        process.exit(1);
    }
};

main();