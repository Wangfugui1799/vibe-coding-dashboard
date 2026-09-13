const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, '../data/config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return { project_name: '', project_path: '', milestones: [] };
  }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// GET /api/config
router.get('/', (req, res) => {
  res.json(readConfig());
});

// PATCH /api/config
router.patch('/', (req, res) => {
  const config = readConfig();
  const updated = { ...config, ...req.body };
  writeConfig(updated);
  res.json(updated);
});

module.exports = router;
