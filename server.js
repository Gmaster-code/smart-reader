const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error al conectar a la base de datos SQLite:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        
        // Crear tabla 'audios'
        // Aseguramos que timestamp se cree siempre desde el inicio.
        db.run(`CREATE TABLE IF NOT EXISTS audios (
            id TEXT PRIMARY KEY,
            member TEXT NOT NULL,
            day INTEGER NOT NULL,
            month INTEGER NOT NULL,
            year INTEGER NOT NULL,
            filePath TEXT NOT NULL,
            timestamp INTEGER DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
            duration REAL,
            count INTEGER DEFAULT 1
        )`, (err) => {
            if (err) {
                console.error('Error al crear la tabla audios:', err.message);
            } else {
                console.log('Tabla audios verificada/creada.');
                // Modificación para añadir la columna 'count' si no existe (ya debería existir con el esquema actualizado)
                db.all("PRAGMA table_info(audios)", (err, rows = []) => {
                    if (err) {
                        console.error('Error al verificar columnas de la tabla audios:', err.message);
                        return;
                    }
                    const hasCountColumn = rows.some(row => row.name === 'count');
                    if (!hasCountColumn) {
                        db.run("ALTER TABLE audios ADD COLUMN count INTEGER DEFAULT 1", (err) => {
                            if (err) {
                                console.error('Error al añadir la columna count a la tabla audios:', err.message);
                            } else {
                                console.log('Columna count añadida a la tabla audios (por si acaso).');
                            }
                        });
                    }
                });
            }
        });

        // Crear tabla 'settings'
        db.run(`CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY DEFAULT 1,
            globalBookTitle TEXT, -- Nuevo nombre para el título editable de la app
            members TEXT,
            lastLoginMode TEXT DEFAULT 'lectura'
        )`, (err) => {
            if (err) {
                console.error('Error al crear la tabla settings:', err.message);
            } else {
                console.log('Tabla settings verificada/creada.');
                db.run(`INSERT OR IGNORE INTO settings (id, globalBookTitle, members, lastLoginMode) VALUES (1, 'Smart Reader', '[]', 'lectura')`, (err) => {
                    if (err) {
                        console.error('Error al inicializar settings:', err.message);
                    } else {
                        console.log('Configuración inicial verificada/creada.');
                    }
                });
            }
        });

        // Nueva tabla para lecturas diarias
        db.run(`CREATE TABLE IF NOT EXISTS daily_readings (
            date_key TEXT PRIMARY KEY, -- Formato YYYY-MM-DD
            bookTitle TEXT,
            startDate TEXT,
            endDate TEXT
        )`, (err) => {
            if (err) {
                console.error('Error al crear la tabla daily_readings:', err.message);
            } else {
                console.log('Tabla daily_readings verificada/creada.');
                cleanOldAudios(); // Ejecutar limpieza al iniciar
            }
        });
    }
});

// Función para limpiar audios antiguos (más de 30 días)
function cleanOldAudios() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    console.log(`[Limpieza] Buscando audios anteriores a: ${new Date(thirtyDaysAgo).toLocaleDateString()}`);

    db.all(`SELECT id, filePath FROM audios WHERE timestamp < ?`, [thirtyDaysAgo], (err, rows) => {
        if (err) {
            console.error('[Limpieza] Error al seleccionar audios antiguos:', err.message);
            return;
        }
        if (rows.length === 0) {
            console.log('[Limpieza] No se encontraron audios antiguos para eliminar.');
            return;
        }

        console.log(`[Limpieza] Se encontraron ${rows.length} audios antiguos para eliminar.`);

        const idsToDelete = rows.map(row => row.id);
        const filesToDelete = rows.map(row => path.join(uploadsDir, row.filePath));

        db.run(`DELETE FROM audios WHERE id IN (${idsToDelete.map(() => '?').join(',')})`, idsToDelete, function(err) {
            if (err) {
                console.error('[Limpieza] Error al eliminar audios de la DB:', err.message);
                return;
            }
            console.log(`[Limpieza] Eliminados ${this.changes} audios de la base de datos.`);

            filesToDelete.forEach(filePath => {
                fs.unlink(filePath, (unlinkErr) => {
                    if (unlinkErr) {
                        if (unlinkErr.code === 'ENOENT') {
                            console.warn(`[Limpieza] Archivo no encontrado (ya eliminado): ${filePath}`);
                        } else {
                            console.error(`[Limpieza] Error al eliminar archivo físico ${filePath}:`, unlinkErr);
                        }
                    } else {
                        console.log(`[Limpieza] Archivo físico eliminado: ${filePath}`);
                    }
                });
            });
        });
    });
}


// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(uploadsDir));

// --- Rutas de la API ---

// Subir audio
app.post('/upload-audio', upload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No se ha subido ningún archivo.');
    }

    const { member, day, month, year, duration } = req.body;
    const id = uuidv4();
    const filePath = req.file.filename;

    db.run(`INSERT INTO audios (id, member, day, month, year, filePath, duration, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, member, parseInt(day), parseInt(month), parseInt(year), filePath, parseFloat(duration), 1],
        function(err) {
            if (err) {
                console.error('Error al insertar audio en la DB:', err.message);
                return res.status(500).json({ error: 'Error al guardar el audio en la base de datos.' });
            }
            res.status(200).json({ message: 'Audio subido y guardado.', audioId: id, filePath: `/uploads/${filePath}` });
        }
    );
});

// Obtener audios por día
app.get('/api/audios/:year/:month/:day', (req, res) => {
    const { year, month, day } = req.params;
    db.all(`SELECT * FROM audios WHERE year = ? AND month = ? AND day = ? ORDER BY timestamp ASC`,
        [year, month, day],
        (err, rows) => {
            if (err) {
                console.error('Error al obtener audios:', err.message);
                return res.status(500).json({ error: 'Error al obtener los audios.' });
            }
            const audios = rows.map(audio => ({
                ...audio,
                filePath: `/uploads/${audio.filePath}`
            }));
            res.json(audios);
        }
    );
});

// Eliminar audio
app.delete('/api/audios/:id', (req, res) => {
    const { id } = req.params;

    db.get(`SELECT filePath FROM audios WHERE id = ?`, [id], (err, row) => {
        if (err) {
            console.error('Error al buscar audio para eliminar:', err.message);
            return res.status(500).json({ error: 'Error al buscar audio para eliminar.' });
        }
        if (!row) {
            return res.status(404).json({ error: 'Audio no encontrado.' });
        }

        const filePathToDelete = path.join(uploadsDir, row.filePath);

        db.run(`DELETE FROM audios WHERE id = ?`, [id], function(err) {
            if (err) {
                console.error('Error al eliminar audio de la DB:', err.message);
                return res.status(500).json({ error: 'Error al eliminar audio de la base de datos.' });
            }
            fs.unlink(filePathToDelete, (err) => {
                if (err) {
                    console.error('Error al eliminar archivo de audio físico:', err);
                }
                res.status(200).json({ message: 'Audio eliminado correctamente.' });
            });
        });
    });
});

// Actualizar conteo de reproducción
app.post('/api/audios/increment-count/:id', (req, res) => {
    const { id } = req.params;
    db.run(`UPDATE audios SET count = count + 1 WHERE id = ?`, [id], function(err) {
        if (err) {
            console.error('Error al incrementar el conteo del audio:', err.message);
            return res.status(500).json({ error: 'Error al actualizar el conteo.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Audio no encontrado para actualizar el conteo.' });
        }
        res.status(200).json({ message: 'Conteo de audio actualizado.' });
    });
});

// --- Rutas de Configuración (Settings) ---

// Obtener configuración (incluye globalBookTitle, miembros y lastLoginMode)
app.get('/api/settings', (req, res) => {
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {
        if (err) {
            console.error('Error al obtener configuración:', err.message);
            return res.status(500).json({ error: 'Error al obtener la configuración.' });
        }
        if (!row) {
            return res.json({
                globalBookTitle: 'Smart Reader',
                members: [],
                lastLoginMode: 'lectura'
            });
        }
        row.members = JSON.parse(row.members || '[]');
        res.json(row);
    });
});

// Guardar configuración (incluye globalBookTitle, miembros y lastLoginMode)
app.post('/api/settings', (req, res) => {
    const { globalBookTitle, members, lastLoginMode } = req.body;
    const membersJson = JSON.stringify(members);

    db.run(`UPDATE settings SET globalBookTitle = ?, members = ?, lastLoginMode = ? WHERE id = 1`,
        [globalBookTitle, membersJson, lastLoginMode],
        function(err) {
            if (err) {
                console.error('Error al guardar configuración:', err.message);
                return res.status(500).json({ error: 'Error al guardar la configuración.' });
            }
            res.status(200).json({ message: 'Configuración guardada correctamente.' });
        }
    );
});

// --- Rutas para Lecturas Diarias ---

// Guardar lectura diaria para una fecha específica
app.post('/api/daily-reading', (req, res) => {
    const { date, bookTitle, startDate, endDate } = req.body;
    db.run(`INSERT OR REPLACE INTO daily_readings (date_key, bookTitle, startDate, endDate) VALUES (?, ?, ?, ?)`,
        [date, bookTitle, startDate, endDate],
        function(err) {
            if (err) {
                console.error('Error al guardar lectura diaria:', err.message);
                return res.status(500).json({ error: 'Error al guardar la lectura diaria.' });
            }
            res.status(200).json({ message: 'Lectura diaria guardada correctamente.' });
        }
    );
});

// Obtener lectura diaria para una fecha específica
app.get('/api/daily-reading/:year/:month/:day', (req, res) => {
    const { year, month, day } = req.params;
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    db.get(`SELECT bookTitle, startDate, endDate FROM daily_readings WHERE date_key = ?`, [dateKey], (err, row) => {
        if (err) {
            console.error('Error al obtener lectura diaria:', err.message);
            return res.status(500).json({ error: 'Error al obtener la lectura diaria.' });
        }
        res.json(row || { bookTitle: '', startDate: '', endDate: '' });
    });
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
    console.log(`Accede a la web localmente abriendo el archivo: file://${path.join(__dirname, 'index.html')}`);
});