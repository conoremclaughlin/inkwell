#!/usr/bin/env node
/**
 * Test script to verify Supabase connection and environment setup
 */

import { getDataComposer } from './data/composer';
import { logger } from './utils/logger';
import { env } from './config/env';

async function testConnection() {
  try {
    logger.info('🧪 Testing Personal Context Protocol setup...\n');

    // Test 1: Environment variables
    logger.info('✅ Environment variables loaded');
    logger.info(`   - Supabase URL: ${env.SUPABASE_URL}`);
    logger.info(`   - MCP Transport: ${env.MCP_TRANSPORT}`);
    logger.info(`   - Node Environment: ${env.NODE_ENV}`);
    logger.info(
      `   - Telegram Bot: ${env.TELEGRAM_BOT_TOKEN ? '✓ Configured' : '✗ Not configured'}`
    );
    logger.info(
      `   - Benson Bot: ${env.TELEGRAM_BENSON_BOT_TOKEN ? '✓ Configured' : '✗ Not configured'}\n`
    );

    // Test 2: Database connection
    logger.info('🔌 Testing database connection...');
    const dataComposer = await getDataComposer();
    logger.info('✅ Data composer initialized\n');

    // Test 3: Health check
    logger.info('❤️  Running health check...');
    const isHealthy = await dataComposer.healthCheck();

    if (!isHealthy) {
      throw new Error('Database health check failed');
    }
    logger.info('✅ Database connection healthy\n');

    // Test 4: Test query
    logger.info('📊 Testing database query...');
    const testUser = await dataComposer.repositories.users.findById(
      '550e8400-e29b-41d4-a716-446655440000'
    );
    if (testUser) {
      logger.info(`✅ Found test user: ${testUser.username || testUser.email || 'Unknown'}\n`);
    } else {
      logger.info('ℹ️  No test user found (this is okay for a fresh database)\n');
    }

    // Summary
    logger.info('🎉 All tests passed! Your setup is ready.');
    logger.info('\n📝 Next steps:');
    logger.info('   1. Run: yarn dev');
    logger.info('   2. Configure Claude Desktop (see SETUP.md)');
    logger.info('   3. Test with: "Save this link: https://example.com"');

    process.exit(0);
  } catch (error) {
    logger.error('❌ Test failed:', error);
    logger.error('\n💡 Troubleshooting:');
    logger.error('   1. Verify your Supabase credentials in .env');
    logger.error('   2. Run the migration: supabase/migrations/001_initial_schema.sql');
    logger.error('   3. Check Supabase project is active and accessible');
    process.exit(1);
  }
}

testConnection();
