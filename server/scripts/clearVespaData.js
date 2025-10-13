import fetch from 'node-fetch';

async function clearAllVespaData() {
  try {
    console.log('🗑️  Clearing all Vespa data...');
    
    // First, let's see what's in Vespa
    const searchUrl = 'http://localhost:8080/search/?yql=select%20*%20from%20jql_query&hits=1000';
    
    console.log('📊 Checking current data in Vespa...');
    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();
    
    const documents = searchData.root?.children || [];
    console.log(`Found ${documents.length} documents to delete`);
    
    if (documents.length === 0) {
      console.log('✅ Vespa is already empty');
      return;
    }
    
    // Delete each document
    let deleteCount = 0;
    for (const doc of documents) {
      const docId = doc.id;
      const deleteUrl = `http://localhost:8080/document/v1/jql_query/jql_query/docid/${encodeURIComponent(docId)}`;
      
      try {
        const deleteResponse = await fetch(deleteUrl, {
          method: 'DELETE'
        });
        
        if (deleteResponse.ok) {
          deleteCount++;
          if (deleteCount % 10 === 0) {
            console.log(`🗑️  Deleted ${deleteCount}/${documents.length} documents...`);
          }
        } else {
          console.error(`❌ Failed to delete document ${docId}: ${deleteResponse.status}`);
        }
      } catch (error) {
        console.error(`❌ Error deleting document ${docId}:`, error.message);
      }
    }
    
    console.log(`\n✅ Deletion complete!`);
    console.log(`   Total documents deleted: ${deleteCount}/${documents.length}`);
    
    // Verify deletion
    console.log('\n🔍 Verifying deletion...');
    const verifyResponse = await fetch(searchUrl);
    const verifyData = await verifyResponse.json();
    const remainingDocs = verifyData.root?.children || [];
    
    console.log(`📊 Remaining documents: ${remainingDocs.length}`);
    
    if (remainingDocs.length === 0) {
      console.log('✅ All data successfully cleared from Vespa!');
    } else {
      console.log('⚠️  Some documents may still remain');
    }
    
  } catch (error) {
    console.error('❌ Error clearing Vespa data:', error);
    throw error;
  }
}

// Run the cleanup
clearAllVespaData().catch(console.error);