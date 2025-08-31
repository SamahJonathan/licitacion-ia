
const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- CONFIGURACIÓN ---
const app = express();
const port = process.env.PORT || 3000;

// Credenciales (reemplazar con variables de entorno en producción)
const SUPABASE_URL = 'https://xxpwbkzxanrhtayzojly.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4cHdia3p4YW5yaHRheXpvamx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY1MjE4NjgsImV4cCI6MjA3MjA5Nzg2OH0.2zaxRRALk_m0cdTW6qwluz75r_oyqISU8L0SR3hcnPE';
const GEMINI_API_KEY = 'AIzaSyD8FCoQ5w_9CxppzDQGeiixgkJm-uP_QNw';

// Inicialización de clientes
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// --- RUTAS ---

/**
 * Ruta principal que renderiza la página de inicio.
 * Asume que existe un archivo `views/index.ejs`.
 */
app.get('/', async (req, res) => {
    try {
        console.log("Obteniendo historial de licitaciones desde Supabase...");
        const { data: licitaciones, error } = await supabase
            .from('licitaciones')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        console.log(`Se encontraron ${licitaciones.length} licitaciones.`);
        res.render('index', { licitaciones: licitaciones || [] });

    } catch (error) {
        console.error("Error al obtener licitaciones:", error);
        res.render('index', { licitaciones: [], error: 'No se pudo cargar el historial.' });
    }
});

/**
 * Endpoint para scrapear una licitación, guardar datos y archivos.
 */
app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url || !url.includes('mercadopublico.cl')) {
        return res.status(400).json({ error: 'URL de Mercado Público no válida.' });
    }

    console.log(`Iniciando scraping para: ${url}`);

    try {
        const licitacionData = await scrapeLicitacion(url);
        console.log('Datos extraídos:', JSON.stringify(licitacionData, null, 2));

        if (!licitacionData.numero) {
            throw new Error("No se pudo extraer el número de la licitación. Es posible que los selectores de scraping necesiten actualizarse.");
        }

        // Guardar datos principales en Supabase
        const { data: licitacionDb, error: licitacionError } = await supabase
            .from('licitaciones')
            .insert([{
                numero: licitacionData.numero,
                nombre: licitacionData.nombre,
                estado: licitacionData.estado,
                monto: licitacionData.monto,
                fecha_cierre: licitacionData.fechaCierre,
                entidad: licitacionData.entidad
            }])
            .select()
            .single();

        if (licitacionError) throw licitacionError;

        console.log('Licitación guardada en la base de datos con ID:', licitacionDb.id);

        // Procesar y subir archivos
        if (licitacionData.documentos && licitacionData.documentos.length > 0) {
            const fileUploadPromises = licitacionData.documentos.map(doc =>
                downloadAndUploadFile(doc.url, doc.nombre, licitacionDb.id)
            );
            await Promise.all(fileUploadPromises);
            console.log('Todos los archivos han sido procesados y subidos.');
        } else {
            console.log('No se encontraron documentos para procesar.');
        }

        res.status(200).json({
            message: 'Scraping y almacenamiento completados con éxito.',
            data: licitacionDb
        });

    } catch (error) {
        console.error('Error en el proceso de scraping:', error);
        res.status(500).json({ error: 'Ocurrió un error en el servidor.', details: error.message });
    }
});


/**
 * Endpoint de chat que interactúa con Gemini.
 */
app.post('/chat', async (req, res) => {
    try {
        console.log('Recibida solicitud de chat:', req.body);
        const { prompt, licitacionId } = req.body;
        if (!prompt || !licitacionId) {
            return res.status(400).json({ error: 'El prompt y el ID de la licitación son requeridos.' });
        }

        // 1. Obtener datos de la licitación
        const { data: licitacion, error: licitacionError } = await supabase
            .from('licitaciones')
            .select('*')
            .eq('id', licitacionId)
            .single();

        if (licitacionError) throw licitacionError;
        if (!licitacion) return res.status(404).json({ error: 'Licitación no encontrada.' });

        // 2. Obtener archivos asociados (opcional)
        let archivos = [];
        try {
            const { data: archivosData, error: archivosError } = await supabase
                .from('archivos')
                .select('nombre')
                .eq('licitacion_id', licitacionId);
            
            if (!archivosError) {
                archivos = archivosData || [];
            }
        } catch (error) {
            console.log('No se pudieron obtener archivos:', error.message);
        }

        // 3. Construir un prompt con contexto enriquecido para la IA
        let context = `Contexto de la Licitación:
`;
        context += ` - Nombre: ${licitacion.nombre}
`;
        context += ` - Número: ${licitacion.numero}
`;
        context += ` - Estado: ${licitacion.estado}
`;
        context += ` - Monto: ${licitacion.monto || 'No especificado'}
`;
        context += ` - Fecha de Cierre: ${new Date(licitacion.fecha_cierre).toLocaleString()}
`;
        context += ` - Entidad: ${licitacion.entidad}
`;

        if (archivos && archivos.length > 0) {
            context += ` - Archivos adjuntos:
`;
            archivos.forEach(archivo => {
                context += `   - ${archivo.nombre}
`;
            });
        }

        const fullPrompt = `${context}\nPregunta del usuario: ${prompt}\n\nResponde a la pregunta del usuario basándote únicamente en el contexto proporcionado. Si la pregunta es sobre un archivo, menciona su nombre y URL.`;

        // 4. Enviar a Gemini
        console.log('Enviando prompt a Gemini...');
        const result = await geminiModel.generateContent(fullPrompt);
        const response = await result.response;
        const text = response.text();
        console.log('Respuesta de Gemini recibida');

        res.json({ response: text });

    } catch (error) {
        console.error('Error al contactar a Gemini:', error);
        res.status(500).json({ error: 'Error al procesar la solicitud de chat.', details: error.message });
    }
});


// --- LÓGICA DE SCRAPING Y ARCHIVOS ---

/**
 * Scrapea la página de una licitación de Mercado Público.
 * @param {string} url - La URL de la licitación.
 * @returns {Promise<object>} - Los datos extraídos de la licitación.
 */
async function scrapeLicitacion(url) {
    let browser = null;
    try {
        console.log('Lanzando Puppeteer...');
        browser = await puppeteer.launch({
            headless: true,
            // executablePath le dice a Puppeteer dónde encontrar el Chromium
            // que instalamos en el Build Command de Render.
            executablePath: puppeteer.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process'
            ]
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });

        console.log('Página cargada. Extrayendo datos...');

        // NOTA: Estos selectores pueden cambiar si Mercado Público actualiza su sitio.
        const data = await page.evaluate(() => {
            const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
            
            // Intenta obtener datos de la nueva (2024+) y la antigua interfaz de Mercado Público
            const numero = getText('p.licitacion-id') || getText('#lblNumLicitacion');
            const nombre = getText('h1.nombre-licitacion') || getText('#lblNombreLicitacion');
            const estado = getText('span.estado-licitacion') || getText('#lblEstado');
            const fechaCierre = getText('span.fecha-cierre') || getText('#lblFechaCierre');
            const entidad = getText('a.nombre-organismo') || getText('a#ctl00_lblEntidad');

            let monto = null;
            try {
                 const labels = Array.from(document.querySelectorAll('strong, b'));
                 const montoLabel = labels.find(el => el.innerText.trim().toLowerCase().startsWith('monto estimado'));
                 if (montoLabel) {
                    // El valor puede estar en el siguiente nodo de texto o en un elemento hermano
                    let currentNode = montoLabel.nextSibling;
                    while(currentNode && currentNode.nodeType !== Node.TEXT_NODE) {
                        currentNode = currentNode.nextSibling;
                    }
                    if(currentNode) {
                        monto = currentNode.textContent.trim();
                    }
                 }
            } catch (e) {}

            const documentos = Array.from(document.querySelectorAll('#grvAnexos tbody tr, #adjuntos-licitacion a, .adjuntos-wrap a')).map(row => {
                const linkElement = row.tagName === 'A' ? row : row.querySelector('a');
                if (linkElement && linkElement.href.includes('idAnexo')) {
                    return {
                        nombre: linkElement.innerText.trim(),
                        url: linkElement.href
                    };
                }
                return null;
            }).filter(Boolean);

            return { numero, nombre, estado, monto, fechaCierre, entidad, documentos };
        });

        return data;
    } finally {
        if (browser) {
            await browser.close();
            console.log('Navegador Puppeteer cerrado.');
        }
    }
}

/**
 * Descarga un archivo, lo sube a Supabase Storage y guarda el registro en la DB.
 * @param {string} fileUrl - URL del archivo a descargar.
 * @param {string} fileName - Nombre original del archivo.
 * @param {number} licitacionId - ID de la licitación a la que pertenece.
 */
async function downloadAndUploadFile(fileUrl, fileName, licitacionId) {
    try {
        console.log(`Descargando archivo: ${fileName}`);
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(response.data);

        const safeFileName = `${Date.now()}_${fileName.replace(/[^a-z0-9._-]/gi, '_')}`;
        const filePathInBucket = `${licitacionId}/${safeFileName}`;

        console.log(`Subiendo archivo a Supabase Storage: ${filePathInBucket}`);
        const { error: uploadError } = await supabase.storage
            .from('licitaciones-archivos')
            .upload(filePathInBucket, fileBuffer, {
                contentType: response.headers['content-type'] || 'application/octet-stream',
                upsert: true
            });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
            .from('licitaciones-archivos')
            .getPublicUrl(filePathInBucket);

        console.log(`Archivo subido. URL pública: ${publicUrl}`);

        const { error: dbError } = await supabase.from('archivos').insert({
            licitacion_id: licitacionId,
            nombre: fileName,
            url: publicUrl,
            path_almacenamiento: filePathInBucket
        });

        if (dbError) throw dbError;

        console.log(`Registro del archivo '${fileName}' guardado.`);

    } catch (error) {
        console.error(`Error procesando el archivo ${fileName}:`, error.message);
        await supabase.from('archivos').insert({
            licitacion_id: licitacionId,
            nombre: fileName,
            error_descarga: error.message
        });
    }
}

// --- INICIO DEL SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});
