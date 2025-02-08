// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { body, param, validationResult } = require('express-validator');
const winston = require('winston');
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const app = express();
const port = process.env.PORT || 3000;

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} ${level}: ${stack || message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Serve static files from "public" directory (for UI)
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Global variable for the database connection.
let db;

// Async IIFE to open the SQLite database and initialize tables.
(async () => {
  try {
    db = await open({
      filename: './database.sqlite',
      driver: sqlite3.Database
    });

    // Create "patients" table.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER,
        gender TEXT,
        regd_no TEXT,
        ip_no TEXT,
        department TEXT,
        ward TEXT,
        doa TEXT,
        dodeath TEXT,
        primary_consultant TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create "clinical_data" table.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER,
        final_diagnosis TEXT,
        chief_complaints TEXT,
        past_medical_history TEXT,
        oemd TEXT,
        hospital_course TEXT,
        investigations TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );
    `);

    // Create "discharge_summaries" table.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS discharge_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER,
        summary_text TEXT,
        reviewed INTEGER DEFAULT 0,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );
    `);

    logger.info("SQLite database initialized successfully.");
  } catch (err) {
    logger.error("Database initialization error: " + err.message);
    process.exit(1);
  }
})();

// Middleware: Validate incoming requests.
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn("Validation error: " + JSON.stringify(errors.array()));
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Helper: Retrieve patient and clinical data.
const getPatientAndClinicalData = async (patientId) => {
  try {
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', patientId);
    if (!patient) throw new Error("Patient not found");
    const clinical = await db.get('SELECT * FROM clinical_data WHERE patient_id = ?', patientId);
    return { patient, clinical };
  } catch (error) {
    throw error;
  }
};

// Function: Generate discharge summary using Gemini AI.
// It builds a prompt with the patient/clinical data in a fixed template and calls Gemini AI.
const generateDischargeSummaryGemini = async ({ patient, clinical }) => {
  const safeUpper = (str) => str ? str.toString().toUpperCase() : 'N/A';
  const formatDate = (dateStr) => dateStr ? new Date(dateStr).toLocaleDateString() : 'N/A';

  const prompt = `
Generate a discharge summary report in the exact format below.
Do not hallucinate details; only use the provided data.

---------------------------
DEPARTMENT OF GENERAL MEDICINE
   DEATH SUMMARY

PATIENT DETAILS:
NAME: ${safeUpper(patient.name)}                              AGE: ${patient.age || 'N/A'} YEARS                                    SEX: ${safeUpper(patient.gender)}
REGD. NO: ${patient.regd_no || 'N/A'}                                                                                                   IP NO : ${patient.ip_no || 'N/A'}
DEPARTMENT: ${safeUpper(patient.department)}                                                                         WARD: ${safeUpper(patient.ward)}
D.O.A: ${formatDate(patient.doa)}                                                                                                D.O.DEATH: ${formatDate(patient.dodeath)}
PRIMARY CONSULTANT: ${safeUpper(patient.primary_consultant)}

FINAL DIAGNOSIS: ${clinical && clinical.final_diagnosis ? safeUpper(clinical.final_diagnosis) : 'N/A'}

CHIEF COMPLAINTS: ${clinical && clinical.chief_complaints ? clinical.chief_complaints : 'N/A'}

PAST MEDICAL HISTORY: ${clinical && clinical.past_medical_history ? clinical.past_medical_history : 'NIL'}

O/E AT EMD:
${clinical && clinical.oemd ? clinical.oemd : 'N/A'}

HOSPITAL COURSE:
${clinical && clinical.hospital_course ? clinical.hospital_course : 'N/A'}

INVESTIGATIONS:
${clinical && clinical.investigations ? clinical.investigations : 'REPORTS ENCLOSED'}

CONSULTANT DOCTORS:
(1) DR. CH. GOPINADH, DNB, IDCCM, FIPM (INTENSIVIST)
(2) DR. V. PRASAD RAO MBBS, DNB (GENERAL MEDICINE)
(3) DR. DIVYA DHATHRI MD (GENERAL MEDICINE)
(4) DR. VAMSHI, DNB (GASTRO)
(5) DR. B. ANIL MD, DM (CARDIOLOGY)
---------------------------

Generate the above discharge summary report exactly in the provided format.
`;

  try {
    const response = await axios.post(process.env.GEMINI_API_ENDPOINT, {
      model: "gemini-1.5-flash",
      messages: [
        {
          role: "system",
          content: "You are a precise clinical documentation assistant. Generate outputs that are factually grounded and follow the exact format provided."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 1024
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data &&
        response.data.choices &&
        response.data.choices.length > 0 &&
        response.data.choices[0].message &&
        response.data.choices[0].message.content) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error("Invalid response structure from Gemini API");
    }
  } catch (error) {
    logger.error("Gemini API error: " + error.message);
    throw error;
  }
};

// ------------------------------
// API Endpoints
// ------------------------------

// 1. Create a new patient record.
app.post('/patients',
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('age').isInt({ min: 0 }).withMessage('Age must be a positive integer'),
    body('gender').notEmpty().withMessage('Gender is required'),
    body('regd_no').optional().trim(),
    body('ip_no').optional().trim(),
    body('department').notEmpty().withMessage('Department is required'),
    body('ward').notEmpty().withMessage('Ward is required'),
    body('doa').isISO8601().withMessage('DOA must be a valid date'),
    body('dodeath').optional().isISO8601().withMessage('D.O.DEATH must be a valid date'),
    body('primary_consultant').notEmpty().withMessage('Primary Consultant is required')
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { name, age, gender, regd_no, ip_no, department, ward, doa, dodeath, primary_consultant } = req.body;
      const result = await db.run(
        `INSERT INTO patients (name, age, gender, regd_no, ip_no, department, ward, doa, dodeath, primary_consultant)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, age, gender, regd_no, ip_no, department, ward, doa, dodeath, primary_consultant]
      );
      // Retrieve the inserted patient record using lastID.
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', result.lastID);
      res.status(201).json({ patient });
    } catch (error) {
      logger.error("Error creating patient record: " + error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

// 2. Add clinical data for a patient.
app.post('/patients/:id/clinical-data',
  [
    param('id').isInt().withMessage('Patient ID must be an integer'),
    body('final_diagnosis').notEmpty().withMessage('Final diagnosis is required'),
    body('chief_complaints').notEmpty().withMessage('Chief complaints are required'),
    body('past_medical_history').optional().trim(),
    body('oemd').optional().trim(),
    body('hospital_course').notEmpty().withMessage('Hospital course is required'),
    body('investigations').notEmpty().withMessage('Investigations information is required')
  ],
  validateRequest,
  async (req, res) => {
    try {
      const patientId = req.params.id;
      const { final_diagnosis, chief_complaints, past_medical_history, oemd, hospital_course, investigations } = req.body;
      const result = await db.run(
        `INSERT INTO clinical_data (patient_id, final_diagnosis, chief_complaints, past_medical_history, oemd, hospital_course, investigations)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [patientId, final_diagnosis, chief_complaints, past_medical_history, oemd, hospital_course, investigations]
      );
      const clinicalData = await db.get('SELECT * FROM clinical_data WHERE id = ?', result.lastID);
      res.status(201).json({ clinicalData });
    } catch (error) {
      logger.error("Error adding clinical data: " + error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

// 3. Generate discharge summary using Gemini AI.
app.get('/patients/:id/generate-summary',
  [
    param('id').isInt().withMessage('Patient ID must be an integer')
  ],
  validateRequest,
  async (req, res) => {
    try {
      const patientId = req.params.id;
      const { patient, clinical } = await getPatientAndClinicalData(patientId);
      if (!clinical) {
        return res.status(400).json({ error: "Clinical data not available for this patient" });
      }
      const summaryText = await generateDischargeSummaryGemini({ patient, clinical });
      const result = await db.run(
        `INSERT INTO discharge_summaries (patient_id, summary_text)
         VALUES (?, ?)`,
        [patientId, summaryText]
      );
      const summary = await db.get('SELECT * FROM discharge_summaries WHERE id = ?', result.lastID);
      res.status(201).json({ summary });
    } catch (error) {
      logger.error("Error generating discharge summary: " + error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

// 4. Update (review) discharge summary (human-in-the-loop).
app.put('/patients/:id/summary',
  [
    param('id').isInt().withMessage('Patient ID must be an integer'),
    body('summary_text').notEmpty().withMessage('Updated summary text is required')
  ],
  validateRequest,
  async (req, res) => {
    try {
      const patientId = req.params.id;
      const { summary_text } = req.body;
      const result = await db.run(
        `UPDATE discharge_summaries
         SET summary_text = ?, reviewed = 1, updated_at = CURRENT_TIMESTAMP
         WHERE patient_id = ?`,
        [summary_text, patientId]
      );
      // Retrieve the updated summary.
      const summary = await db.get(
        `SELECT * FROM discharge_summaries
         WHERE patient_id = ?
         ORDER BY generated_at DESC
         LIMIT 1`,
        [patientId]
      );
      if (!summary) {
        return res.status(404).json({ error: "Discharge summary not found for this patient" });
      }
      res.status(200).json({ summary });
    } catch (error) {
      logger.error("Error updating discharge summary: " + error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

// 5. Fetch the latest discharge summary.
app.get('/patients/:id/summary',
  [
    param('id').isInt().withMessage('Patient ID must be an integer')
  ],
  validateRequest,
  async (req, res) => {
    try {
      const patientId = req.params.id;
      const summary = await db.get(
        `SELECT * FROM discharge_summaries
         WHERE patient_id = ?
         ORDER BY generated_at DESC
         LIMIT 1`,
        [patientId]
      );
      if (!summary) {
        return res.status(404).json({ error: "No discharge summary found for this patient" });
      }
      res.status(200).json({ summary });
    } catch (error) {
      logger.error("Error fetching discharge summary: " + error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

// 6. Health check endpoint.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// Global error handling middleware.
app.use((err, req, res, next) => {
  logger.error("Unhandled error: " + err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// Start the server, binding explicitly to localhost.
app.listen(port, 'localhost', () => {
  logger.info(`Server running on http://localhost:${port}`);
});
