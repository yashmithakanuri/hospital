# Hospital Appointment Booking System

This project is a full-stack hospital appointment booking application built with HTML, CSS, Bootstrap 5, JavaScript, Node.js core modules, and AWS DynamoDB.

## Project Overview

The application supports:

- Patient registration and login
- Admin login
- Doctor management by admin
- Patient appointment booking and cancellation
- Appointment history and admin reports
- Session handling with in-memory cookies
- DynamoDB as the persistent data store

## Project Structure

```text
hospital-project/
├── public/
│   ├── index.html
│   ├── login.html
│   ├── register.html
│   ├── dashboard.html
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   └── script.js
│   └── images/
│       ├── hospital-bg.svg
│       ├── login-illustration.svg
│       └── register-illustration.svg
├── db.js
├── server.js
├── README.md
└── package.json
```

## DynamoDB Design

The app uses DynamoDB tables for persistence:

- hospital_users
- hospital_doctors
- hospital_appointments
- hospital_counters

The database layer in `db.js` creates the tables automatically when the app starts, provided the AWS credentials and region are configured.

## Default Admin Login

- Email: `admin@gmail.com`
- Password: `admin123`

## Environment Variables

Set these before running the server:

```bash
export PORT=3100
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_SESSION_TOKEN=your_session_token_if_needed
```

Optional for local DynamoDB emulators or LocalStack:

```bash
export AWS_DYNAMODB_ENDPOINT=http://localhost:8000
```

## Installation

```bash
npm install
```

## Run the Project

```bash
node server.js
```

Then open:

```text
http://localhost:3100
```

## Important Notes

- This project avoids Express.js and uses Node.js core modules only.
- Routing and session handling are managed manually in `server.js`.
- Static assets are served directly from the `public` folder.
- Passwords are kept in plain text for learning simplicity, and the app is ready to be adapted to AWS deployment with secure credentials and IAM policies.

## AWS Deployment Notes

For production deployment on AWS:

- Store credentials using IAM roles or AWS Secrets Manager.
- Use a VPC and security group policy suitable for your environment.
- Prefer a managed AWS environment with DynamoDB access granted through IAM.
- Keep the app behind a reverse proxy or load balancer when deployed publicly.

## Features Included

- Patient registration
- Patient login
- Admin login
- View doctors
- Add, edit, and delete doctors
- Book and cancel appointments
- Prevent duplicate same-slot bookings
- Admin dashboard statistics
- Appointment history
