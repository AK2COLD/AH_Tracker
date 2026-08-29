import 'dotenv/config';
import { createApp } from './api.js';
import { startImporter } from './importer.js';
import { startTsmImporter } from './tsm_importer.js';
import { startTsmSalesImporter } from './tsm_sales_importer.js';

const PORT = process.env.PORT || 3000;

const app = createApp();
app.listen(PORT, () => {
    console.log(`[server] AH Tracker running at http://localhost:${PORT}`);
});

// Watch AHTrackerExport SavedVariables (character data, recipes, production log, scan_log)
startImporter();

// Watch TSM AppData.lua (market context: regional sale rate, market value baseline)
startTsmImporter();

// Watch TSM personal sales history (sold item log for P&L)
startTsmSalesImporter();
