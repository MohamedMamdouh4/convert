const express = require('express');
const multer = require('multer');
const axios = require('axios');
const dotenv = require('dotenv');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

dotenv.config();

const app = express();
const port = 6000;

//  enable CORS for all origins
const cors = require('cors')
app.use(cors());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage }).single('file');  // Ensure the field name is 'file' lazem file m4 ay 7aga tanya

// OpenAI integration
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/upload', upload, (req, res) => {
  const videoDuration = parseInt(req.body.duration);  // Get video duration from user input

  if (isNaN(videoDuration) || videoDuration <= 0) {
    return res.status(400).send('Invalid video duration provided.');
  }

  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).send('No file uploaded.');
  }

  const segmentDuration = 30; // Segment duration in seconds lazem belswanay 
  const totalSegments = Math.ceil(videoDuration / segmentDuration);

  const promises = [];
  const transcriptionResults = [];

  for (let i = 0; i < totalSegments; i++) {
    const cutStart = i * segmentDuration;
    const cutEnd = Math.min((i + 1) * segmentDuration, videoDuration);

    const cutStartFormatted = formatTime(cutStart);
    const cutEndFormatted = formatTime(cutEnd);

    const inputBody = {
        "tasks": {
            "import-1": {
                "operation": "import/upload"
            },
            "convert-1": {
                "operation": "convert",
                "input": "import-1",
                "input_format": "mp4",
                "output_format": "mp3",
                "options": {
                    "video_audio_remove": false,
                    "cut_start": cutStartFormatted,
                    "cut_end": cutEndFormatted
                }
            },
            "export-1": {
                "operation": "export/url",
                "input": ["convert-1"]
            }
        }
    };

    promises.push(processFile(inputBody, req.file, i + 1, cutStart, cutEnd, transcriptionResults));
}

  Promise.all(promises)
    .then(() => {
      res.status(200).send({ message: 'Files uploaded, converted, and saved successfully', transcriptionResults });
    })
    .catch(error => {
      console.error('Error during file conversion:', error);
      res.status(500).send('An error occurred during file conversion.');
    });
});

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

async function processFile(inputBody, file, index, cutStart, cutEnd, transcriptionResults) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${process.env.FREECONVERT_API_KEY}`
  };

  try {
    // Step 1: Create a job
    const createJobResponse = await axios.post('https://api.freeconvert.com/v1/process/jobs', inputBody, { headers });
    const jobId = createJobResponse.data.id;

    console.log('Create Job Response:', createJobResponse.data);

    const importTask = createJobResponse.data.tasks.find(task => task.name === 'import-1');
    if (!importTask || !importTask.result) {
      console.error('Missing import-1 result:', createJobResponse.data);
      throw new Error('An error occurred: Missing import-1 result.');
    }

    const uploadUrl = importTask.result.form.url;
    const uploadParams = importTask.result.form.parameters;

    // Step 2: Upload the file from my device
    const formData = new FormData();
    for (const key in uploadParams) {
      formData.append(key, uploadParams[key]);
    }
    formData.append('file', file.buffer, file.originalname);

    await axios.post(uploadUrl, formData, {
      headers: {
        ...formData.getHeaders()
      }
    });

    let jobStatus = 'processing';
    let downloadUrl;
    while (jobStatus === 'processing') {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds to wait the process
      const statusResponse = await axios.get(`https://api.freeconvert.com/v1/process/jobs/${jobId}`, { headers });
      jobStatus = statusResponse.data.status;
      console.log(`Job status: ${jobStatus}`);
      if (jobStatus === 'completed') {
        const exportTask = statusResponse.data.tasks.find(task => task.name === 'export-1');
        if (exportTask && exportTask.result && exportTask.result.url) {
          downloadUrl = exportTask.result.url;
        } else {
          console.error('Missing export-1 result:', statusResponse.data);
          throw new Error('An error occurred: Missing export-1 result.');
        }
      }
    }

    if (jobStatus === 'completed' && downloadUrl) {
      const fileResponse = await axios.get(downloadUrl, { responseType: 'stream' });
      const filePath = path.join(__dirname, 'converted', `converted_part${index}.mp3`);
      const writer = fs.createWriteStream(filePath);
      fileResponse.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // Transcribe the file
      const transcription = await transcribeFile(filePath);
      transcriptionResults.push({ part: index, "time duration": `${cutStart}:${cutEnd}`, transcription });

      return { message: `File part ${index} saved successfully`, filePath };

    } else {
      throw new Error('An error occurred during file conversion.');
    }

  } catch (error) {
    console.error('Error during file conversion:', error.response ? error.response.data : error.message);
    throw new Error('An error occurred during file conversion.');
  }
}

const recapContent = async (myContent) => {
  try {
      const prompt = `write a recap of this ${myContent} 
            write it in detail, giving me a scence by scene explation of this part `;
      const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
              { role: "user", content: prompt },
          ]
      });

      const result = completion.choices[0].message.content.trim();
      const [title, ...newContent] = result.split('\n');
      return {
          title: title.replace("Title: ", "").trim(),
          content: newContent.join(' ').trim()
      };
  } catch (error) {
      console.error("Error generating recap:", error);
      throw error;
  }
};

async function transcribeFile(filePath) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: "text",
    });

    console.log("Transcription result:", transcription);
    const generatedScript = await recapContent(transcription);
    return generatedScript;
  } catch (error) {
    console.error("Error during transcription:", error);
    throw new Error('An error occurred during transcription.');
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
