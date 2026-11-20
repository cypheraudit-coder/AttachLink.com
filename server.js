const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Set these two values to receive a real copy on your phone's Gmail app.
// Leave as-is if you only want Ethereal terminal previews.
const PHONE_ALERT_GMAIL = 'YOUR_PHONE_GMAIL@gmail.com';
const PHONE_GMAIL_APP_PASSWORD = 'YOUR_16_CHAR_APP_PASSWORD_NO_SPACES';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.static(__dirname));

const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'attachment_portal',
    waitForConnections: true,
    connectionLimit: 10
});

// Ethereal captures demo messages and provides preview links in the terminal.
// It does not deliver emails to real inboxes.
let etherealSetup;
let phoneTransporter;

async function getEtherealTransporter() {
    if (!etherealSetup) {
        etherealSetup = nodemailer.createTestAccount().then((account) => ({
            account,
            transporter: nodemailer.createTransport({
                host: account.smtp.host,
                port: account.smtp.port,
                secure: account.smtp.secure,
                auth: {
                    user: account.user,
                    pass: account.pass
                }
            })
        }));
    }

    return etherealSetup;
}

function getPhoneTransporter() {
    const hasGmail =
        PHONE_ALERT_GMAIL &&
        PHONE_ALERT_GMAIL !== 'YOUR_PHONE_GMAIL@gmail.com';
    const cleanPass = (PHONE_GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    const hasPass =
        cleanPass &&
        cleanPass !== 'YOUR_16_CHAR_APP_PASSWORD_NO_SPACES';

    if (!hasGmail || !hasPass) {
        return null;
    }

    if (!phoneTransporter) {
        phoneTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: PHONE_ALERT_GMAIL.trim(),
                pass: cleanPass
            }
        });
    }

    return phoneTransporter;
}

async function sendPhoneCopyEmail(intendedRecipient, subject, messageBody) {
    const gmailTransport = getPhoneTransporter();
    if (!gmailTransport) {
        return false;
    }

    try {
        await gmailTransport.sendMail({
            from: `"Attachment Portal Alert" <${PHONE_ALERT_GMAIL.trim()}>`,
            to: PHONE_ALERT_GMAIL.trim(),
            subject: `[Phone Demo] ${subject}`,
            text: `Intended Recipient: ${intendedRecipient}\n\n${messageBody}`
        });

        console.log(`Phone alert sent to ${PHONE_ALERT_GMAIL.trim()}`);
        return true;
    } catch (phoneErr) {
        console.error('Phone Gmail alert error:', phoneErr.message);
        return false;
    }
}

async function sendNotificationEmail(recipientEmail, subject, messageBody) {
    let etherealSent = false;

    try {
        const { account, transporter } = await getEtherealTransporter();

        const info = await transporter.sendMail({
            from: `"Attachment Portal Demo" <${account.user}>`,
            to: recipientEmail,
            subject,
            text: messageBody
        });

        const previewUrl = nodemailer.getTestMessageUrl(info);

        console.log('\n--- ETHEREAL DEMO EMAIL ---');
        console.log('Recipient:', recipientEmail);
        console.log('Subject:', subject);
        console.log('Preview:', previewUrl);
        console.log('This message was captured for preview, not delivered.');
        console.log('---------------------------\n');

        etherealSent = true;
    } catch (error) {
        console.error('Ethereal demo email error:', error.message);
    }

    const phoneSent = await sendPhoneCopyEmail(
        recipientEmail,
        subject,
        messageBody
    );

    return etherealSent || phoneSent;
}

const storage = multer.diskStorage({
    destination: (req, file, callback) => {
        callback(null, uploadsDir);
    },
    filename: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const uniqueName =
            `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
        callback(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const allowedExtensions = ['.pdf', '.doc', '.docx'];

        if (!allowedExtensions.includes(extension)) {
            return callback(new Error('Upload a PDF, DOC, or DOCX file.'));
        }

        return callback(null, true);
    }
});

function normalizeApplicationStatus(status) {
    return status === 'Accepted' ? 'Approved' : status;
}

function seedAdminAccount() {
    const adminEmail = 'admin@portal.co.ke';
    const adminPassword = 'admin123';

    db.query(
        'SELECT id FROM users WHERE email = ?',
        [adminEmail],
        (err, results) => {
            if (err) {
                console.error('Database error checking admin:', err.message);
                return;
            }

            if (results.length > 0) {
                console.log('Admin account already exists in database.');
                return;
            }

            bcrypt.hash(adminPassword, 10, (hashErr, hashedPassword) => {
                if (hashErr) {
                    console.error(
                        'Error hashing admin password:',
                        hashErr.message
                    );
                    return;
                }

                db.query(
                    'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
                    [adminEmail, hashedPassword, 'admin'],
                    (insertErr) => {
                        if (insertErr) {
                            console.error(
                                'Failed to create default admin:',
                                insertErr.message
                            );
                        } else {
                            console.log('Default Admin Account Auto-Created!');
                        }
                    }
                );
            });
        }
    );
}

// Login. Applicants use their users.id as profileId.
// Employers use their employer_profiles.id as profileId.
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    db.query(
        'SELECT id, email, password, role FROM users WHERE email = ?',
        [email],
        (err, results) => {
            if (err || results.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid email or password'
                });
            }

            const user = results[0];

            bcrypt.compare(password, user.password, (compareErr, matches) => {
                if (compareErr) {
                    console.error('Login error:', compareErr.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Server error during login.'
                    });
                }

                if (!matches) {
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid email or password'
                    });
                }

                if (user.role !== 'employer') {
                    return res.json({
                        success: true,
                        role: user.role,
                        userId: user.id,
                        profileId: user.id
                    });
                }

                db.query(
                    'SELECT id AS profileId FROM employer_profiles WHERE user_id = ?',
                    [user.id],
                    (profileErr, profiles) => {
                        if (profileErr) {
                            console.error(
                                'Error finding employer profile:',
                                profileErr.message
                            );
                            return res.status(500).json({
                                success: false,
                                message: 'Could not load employer profile.'
                            });
                        }

                        return res.json({
                            success: true,
                            role: user.role,
                            userId: user.id,
                            profileId: profiles.length
                                ? profiles[0].profileId
                                : null
                        });
                    }
                );
            });
        }
    );
});

// Register users and create the required employer profile.
app.post('/api/register', async (req, res) => {
    const {
        email,
        password,
        role,
        fullName,
        first_name,
        last_name,
        company_name,
        industry,
        location,
        contact_person
    } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: 'Email and password are required.'
        });
    }

    const accountRole = role || 'applicant';
    const displayName =
        fullName ||
        [first_name, last_name].filter(Boolean).join(' ') ||
        'User';

    if (
        accountRole === 'employer' &&
        (!company_name || !industry || !location || !contact_person)
    ) {
        return res.status(400).json({
            success: false,
            message:
                'Company name, industry, location, and contact person are required for employer accounts.'
        });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.query(
            'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
            [email, hashedPassword, accountRole],
            (userErr, userResult) => {
                if (userErr) {
                    console.error(
                        'Registration database error:',
                        userErr.message
                    );
                    return res.status(500).json({
                        success: false,
                        message:
                            'Registration failed or email already exists.'
                    });
                }

                const userId = userResult.insertId;

                const sendRegistrationEmails = async () => {
                    const userEmailSent = await sendNotificationEmail(
                        email,
                        'Account Successfully Created',
                        `Hello ${displayName},

Your account has been successfully created on the Attachment Portal.
Role: ${accountRole}`
                    );

                    const adminEmailSent = await sendNotificationEmail(
                        'admin@portal.co.ke',
                        'New User Registration',
                        `A new ${accountRole} account was registered with email: ${email}.`
                    );

                    const emailsSent = userEmailSent && adminEmailSent;

                    return res.json({
                        success: true,
                        emailSent: emailsSent,
                        emailMode: 'Ethereal preview + phone copy',
                        message: emailsSent
                            ? 'Registration completed. Demo email previews are in the terminal and alerts were sent.'
                            : 'Registration completed. Check the server terminal for email status or preview links.'
                    });
                };

                if (accountRole !== 'employer') {
                    sendRegistrationEmails();
                    return;
                }

                db.query(
                    `INSERT INTO employer_profiles
                        (user_id, company_name, industry, location, contact_person)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        userId,
                        company_name,
                        industry,
                        location,
                        contact_person
                    ],
                    (profileErr) => {
                        if (profileErr) {
                            console.error(
                                'Employer profile creation error:',
                                profileErr.message
                            );

                            db.query(
                                'DELETE FROM users WHERE id = ?',
                                [userId],
                                (deleteErr) => {
                                    if (deleteErr) {
                                        console.error(
                                            'Could not remove incomplete employer account:',
                                            deleteErr.message
                                        );
                                    }
                                }
                            );

                            return res.status(500).json({
                                success: false,
                                message:
                                    'Could not create the employer profile. Registration was not completed.'
                            });
                        }

                        sendRegistrationEmails();
                    }
                );
            }
        );
    } catch (error) {
        console.error('Registration error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Server error during registration.'
        });
    }
});

// Fetch active listings for student, public, and admin pages.
app.get('/api/listings', (req, res) => {
    const query = `
        SELECT
            l.id AS listing_id,
            l.title,
            l.description,
            l.requirements,
            l.location,
            l.deadline,
            l.status,
            l.created_at,
            ep.company_name
        FROM listings AS l
        JOIN employer_profiles AS ep ON ep.id = l.employer_id
        WHERE l.status = 'active'
        ORDER BY l.created_at DESC
    `;

    db.query(query, (err, listings) => {
        if (err) {
            console.error('Database error fetching listings:', err.message);
            return res.status(500).json({
                error: 'Failed to load job listings.'
            });
        }

        return res.json(listings);
    });
});

// Upload a CV and submit an application.
app.post('/api/applications', (req, res) => {
    upload.single('resume')(req, res, (uploadErr) => {
        if (uploadErr) {
            console.error('CV upload error:', uploadErr.message);
            return res.status(400).json({
                error: uploadErr.message || 'Could not upload the CV.'
            });
        }

        const listingId = Number(req.body.listing_id);
        const applicantId = Number(req.body.applicant_id);

        if (!req.file) {
            return res.status(400).json({
                error: 'Please attach your CV document.'
            });
        }

        if (!Number.isInteger(listingId) || !Number.isInteger(applicantId)) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({
                error: 'The listing or applicant ID is invalid. Sign in again and retry.'
            });
        }

        db.query(
            `SELECT id FROM users
             WHERE id = ? AND role = 'applicant'`,
            [applicantId],
            (userErr, users) => {
                if (userErr) {
                    fs.unlink(req.file.path, () => {});
                    console.error(
                        'Database error checking applicant:',
                        userErr.message
                    );
                    return res.status(500).json({
                        error: 'Could not verify the applicant account.'
                    });
                }

                if (users.length === 0) {
                    fs.unlink(req.file.path, () => {});
                    return res.status(400).json({
                        error: 'Applicant account not found. Sign out and sign in again.'
                    });
                }

                db.query(
                    `SELECT id FROM listings
                     WHERE id = ? AND status = 'active'`,
                    [listingId],
                    (listingErr, listings) => {
                        if (listingErr) {
                            fs.unlink(req.file.path, () => {});
                            console.error(
                                'Database error checking listing:',
                                listingErr.message
                            );
                            return res.status(500).json({
                                error: 'Could not verify the opportunity.'
                            });
                        }

                        if (listings.length === 0) {
                            fs.unlink(req.file.path, () => {});
                            return res.status(404).json({
                                error: 'This opportunity is no longer available.'
                            });
                        }

                        const resumePath = path
                            .relative(__dirname, req.file.path)
                            .split(path.sep)
                            .join('/');

                        db.query(
                            `INSERT INTO applications
                                (listing_id, applicant_id, status, resume_path)
                             VALUES (?, ?, 'Pending', ?)`,
                            [listingId, applicantId, resumePath],
                            (insertErr) => {
                                if (insertErr) {
                                    fs.unlink(req.file.path, () => {});
                                    console.error(
                                        'Database error creating application:',
                                        insertErr.message
                                    );
                                    return res.status(500).json({
                                        error: 'Could not save the application.'
                                    });
                                }

                                return res.json({
                                    success: true,
                                    message: 'Application submitted successfully!'
                                });
                            }
                        );
                    }
                );
            }
        );
    });
});

// Load a student's application tracker.
app.get('/api/applicant/applications/:id', (req, res) => {
    const applicantId = Number(req.params.id);

    const query = `
        SELECT
            a.id AS application_id,
            a.status,
            a.applied_at,
            l.title AS job_title,
            l.location,
            ep.company_name
        FROM applications AS a
        JOIN listings AS l ON l.id = a.listing_id
        JOIN employer_profiles AS ep ON ep.id = l.employer_id
        WHERE a.applicant_id = ?
        ORDER BY a.applied_at DESC
    `;

    db.query(query, [applicantId], (err, applications) => {
        if (err) {
            console.error(
                'Database error fetching applicant applications:',
                err.message
            );
            return res.status(500).json({
                error: 'Failed to load applications.'
            });
        }

        return res.json(applications);
    });
});

// Load applications for an employer.
app.get('/api/employer/applications/:id', (req, res) => {
    const employerId = Number(req.params.id);

    const query = `
        SELECT
            a.id AS application_id,
            a.applicant_id,
            a.status,
            a.applied_at,
            a.resume_path,
            l.title AS job_title
        FROM applications AS a
        JOIN listings AS l ON l.id = a.listing_id
        WHERE l.employer_id = ?
        ORDER BY a.applied_at DESC
    `;

    db.query(query, [employerId], (err, applications) => {
        if (err) {
            console.error(
                'Database error fetching employer applications:',
                err.message
            );
            return res.status(500).json({
                error: 'Failed to load employer applications.'
            });
        }

        return res.json(applications);
    });
});

// Update application status and create a demo email preview when approved.
app.put('/api/applications/:id', (req, res) => {
    const applicationId = Number(req.params.id);
    const status = normalizeApplicationStatus(req.body.status);
    const allowedStatuses = ['Pending', 'Approved', 'Rejected'];

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid application status.'
        });
    }

    const detailsQuery = `
        SELECT u.email AS student_email, l.title AS job_title
        FROM applications AS a
        JOIN users AS u ON u.id = a.applicant_id
        JOIN listings AS l ON l.id = a.listing_id
        WHERE a.id = ?
    `;

    db.query(detailsQuery, [applicationId], (lookupErr, rows) => {
        if (lookupErr) {
            console.error(
                'Database error finding application:',
                lookupErr.message
            );
            return res.status(500).json({
                success: false,
                message: 'Database error finding the application.'
            });
        }

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Application not found.'
            });
        }

        db.query(
            'UPDATE applications SET status = ? WHERE id = ?',
            [status, applicationId],
            (updateErr) => {
                if (updateErr) {
                    console.error(
                        'Database error updating status:',
                        updateErr.message
                    );
                    return res.status(500).json({
                        success: false,
                        message: 'Database error updating application status.'
                    });
                }

                if (status !== 'Approved') {
                    return res.json({
                        success: true,
                        emailSent: null,
                        message: 'Application status updated successfully.'
                    });
                }

                sendNotificationEmail(
                    rows[0].student_email,
                    'Congratulations! Attachment Placement Found',
                    `Dear Student,

Great news! Your application for "${rows[0].job_title}" has been approved. Log in to your dashboard for details.`
                ).then((emailSent) => {
                    return res.json({
                        success: true,
                        emailSent,
                        emailMode: 'Ethereal preview + phone copy',
                        message: emailSent
                            ? 'Application approved. Demo email previews are in the terminal and phone alert sent.'
                            : 'Application approved. Check the server terminal for email status or preview links.'
                    });
                });
            }
        );
    });
});

// Post a job listing.
app.post('/api/listings', (req, res) => {
    const {
        employer_id,
        title,
        description,
        location,
        deadline
    } = req.body;

    if (!employer_id || !title || !description) {
        return res.status(400).json({
            error: 'Employer profile ID, job title, and description are required.'
        });
    }

    const query = `
        INSERT INTO listings
            (employer_id, title, description, requirements, location, deadline, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
    `;

    db.query(
        query,
        [
            employer_id,
            title,
            description,
            description,
            location || null,
            deadline || null
        ],
        (err) => {
            if (err) {
                console.error('Database error posting job:', err.message);
                return res.status(500).json({
                    error: 'Failed to post job listing in database.'
                });
            }

            return res.json({
                success: true,
                message: 'Job vacancy posted successfully!'
            });
        }
    );
});

// Return JSON for unknown API paths instead of an HTML error page.
app.use('/api', (req, res) => {
    return res.status(404).json({
        error: `API route not found: ${req.method} ${req.originalUrl}`
    });
});

// Handle API middleware errors as JSON.
app.use((err, req, res, next) => {
    console.error('Server error:', err.message);

    if (req.originalUrl.startsWith('/api/')) {
        return res.status(500).json({
            error: err.message || 'Server error.'
        });
    }

    return next(err);
});

app.listen(PORT, () => {
    console.log(`Server is running live on http://localhost:${PORT}`);
    seedAdminAccount();
});