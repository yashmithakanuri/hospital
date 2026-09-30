const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const {
  ensureDynamoTables,
  findUserByEmail,
  createUser,
  findUserByCredentials,
  listDoctors,
  getDoctorById,
  createDoctor,
  updateDoctor,
  deleteDoctor,
  listAppointmentsForAdmin,
  listAppointmentsForPatient,
  findAppointmentSlot,
  createAppointment,
  cancelAppointment,
  getAdminStats,
  ensureSeedData,
} = require("./db");

const sessions = {};
const PORT = process.env.PORT || 3100;
const publicFolder = path.join(__dirname, "public");

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

function parseRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk.toString();
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON data."));
      }
    });

    request.on("error", () => {
      reject(new Error("Unable to read request data."));
    });
  });
}

function parseCookies(request) {
  const cookies = {};
  const cookieHeader = request.headers.cookie || "";

  cookieHeader.split(";").forEach((item) => {
    if (!item.trim()) {
      return;
    }

    const parts = item.split("=");
    const key = parts[0].trim();
    const value = parts.slice(1).join("=").trim();
    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function createSession(user) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  sessions[sessionId] = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
  };
  return sessionId;
}

function getSessionUser(request) {
  const cookies = parseCookies(request);
  const sessionId = cookies.session_id;
  return sessionId && sessions[sessionId] ? sessions[sessionId] : null;
}

function destroySession(request) {
  const cookies = parseCookies(request);
  const sessionId = cookies.session_id;

  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
  }
}

function validateUserInput(data) {
  const namePattern = /^[A-Za-z ]+$/;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const mobilePattern = /^\d{10}$/;

  if (!data.full_name || !data.full_name.trim()) {
    return "Name is required.";
  }

  if (!namePattern.test(data.full_name.trim())) {
    return "Name must contain alphabets only.";
  }

  if (!data.email || !data.email.trim()) {
    return "Email is required.";
  }

  if (!emailPattern.test(data.email.trim())) {
    return "Enter a valid email address.";
  }

  if (!data.password || data.password.length < 6) {
    return "Password must be at least 6 characters.";
  }

  if (!data.mobile || !mobilePattern.test(data.mobile.trim())) {
    return "Mobile number must be exactly 10 digits.";
  }

  return null;
}

function validateDoctorInput(data) {
  const doctorNamePattern = /^[A-Za-z .]+$/;

  if (!data.doctor_name || !data.doctor_name.trim()) {
    return "Doctor name is required.";
  }

  if (!doctorNamePattern.test(data.doctor_name.trim())) {
    return "Doctor name must contain alphabets only.";
  }

  if (!data.specialization || !data.specialization.trim()) {
    return "Specialization is required.";
  }

  if (!data.schedule || !data.schedule.trim()) {
    return "Availability schedule is required.";
  }

  if (data.fees === undefined || data.fees === null || Number(data.fees) < 0) {
    return "Consultation fee must be 0 or more.";
  }

  return null;
}

function validateAppointmentInput(data) {
  if (!data.doctor_id) {
    return "Please select a doctor.";
  }

  if (!data.appointment_date) {
    return "Appointment date is required.";
  }

  if (!data.appointment_time) {
    return "Appointment time is required.";
  }

  if (!data.reason || !data.reason.trim()) {
    return "Reason for appointment is required.";
  }

  return null;
}

function serveStaticFile(response, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("File not found.");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[extension] || "text/plain";

    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  });
}

function handleStaticRoutes(request, response, pathname) {
  if (pathname === "/") {
    serveStaticFile(response, path.join(publicFolder, "index.html"));
    return true;
  }

  const pageRoutes = {
    "/login": "login.html",
    "/register": "register.html",
    "/dashboard": "dashboard.html",
  };

  if (pageRoutes[pathname]) {
    serveStaticFile(response, path.join(publicFolder, pageRoutes[pathname]));
    return true;
  }

  const requestedFilePath = path.join(publicFolder, pathname.replace(/^\/+/, ""));
  if (requestedFilePath.startsWith(publicFolder) && fs.existsSync(requestedFilePath) && fs.statSync(requestedFilePath).isFile()) {
    serveStaticFile(response, requestedFilePath);
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const pathname = requestUrl.pathname;
    const sessionUser = getSessionUser(request);

    if (request.method === "GET" && handleStaticRoutes(request, response, pathname)) {
      return;
    }

    if (request.method === "GET" && pathname === "/api/session") {
      sendJson(response, 200, { success: true, user: sessionUser });
      return;
    }

    if (request.method === "POST" && pathname === "/api/register") {
      const body = await parseRequestBody(request);
      const validationError = validateUserInput(body);

      if (validationError) {
        sendJson(response, 400, { success: false, message: validationError });
        return;
      }

      const existingUser = await findUserByEmail(body.email.trim().toLowerCase());
      if (existingUser) {
        sendJson(response, 409, { success: false, message: "Email is already registered." });
        return;
      }

      await createUser({
        full_name: body.full_name,
        email: body.email,
        password: body.password,
        mobile: body.mobile,
        role: "patient",
      });

      sendJson(response, 201, { success: true, message: "Registration successful. Please log in." });
      return;
    }

    if (request.method === "POST" && pathname === "/api/login") {
      const body = await parseRequestBody(request);
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const role = body.role || "patient";

      if (!email || !password) {
        sendJson(response, 400, { success: false, message: "Email and password are required." });
        return;
      }

      const user = await findUserByCredentials(email, password, role);
      if (!user) {
        sendJson(response, 401, { success: false, message: "Invalid login credentials." });
        return;
      }

      const sessionId = createSession(user);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `session_id=${sessionId}; HttpOnly; Path=/; Max-Age=86400`,
      });
      response.end(JSON.stringify({ success: true, message: "Login successful.", user }));
      return;
    }

    if (request.method === "POST" && pathname === "/api/logout") {
      destroySession(request);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "session_id=; HttpOnly; Path=/; Max-Age=0",
      });
      response.end(JSON.stringify({ success: true, message: "Logged out successfully." }));
      return;
    }

    if (request.method === "GET" && pathname === "/api/doctors") {
      const doctors = await listDoctors();
      sendJson(response, 200, { success: true, doctors });
      return;
    }

    if (request.method === "POST" && pathname === "/api/doctors") {
      if (!sessionUser || sessionUser.role !== "admin") {
        sendJson(response, 403, { success: false, message: "Admin access required." });
        return;
      }

      const body = await parseRequestBody(request);
      const validationError = validateDoctorInput(body);

      if (validationError) {
        sendJson(response, 400, { success: false, message: validationError });
        return;
      }

      await createDoctor({
        doctor_name: body.doctor_name,
        specialization: body.specialization,
        schedule: body.schedule,
        fees: body.fees,
      });

      sendJson(response, 201, { success: true, message: "Doctor added successfully." });
      return;
    }

    if (request.method === "PUT" && pathname.startsWith("/api/doctors/")) {
      if (!sessionUser || sessionUser.role !== "admin") {
        sendJson(response, 403, { success: false, message: "Admin access required." });
        return;
      }

      const doctorId = Number(pathname.split("/").pop());
      const body = await parseRequestBody(request);
      const validationError = validateDoctorInput(body);

      if (!doctorId) {
        sendJson(response, 400, { success: false, message: "Invalid doctor ID." });
        return;
      }

      if (validationError) {
        sendJson(response, 400, { success: false, message: validationError });
        return;
      }

      const doctor = await updateDoctor(doctorId, {
        doctor_name: body.doctor_name,
        specialization: body.specialization,
        schedule: body.schedule,
        fees: body.fees,
      });

      if (!doctor) {
        sendJson(response, 404, { success: false, message: "Doctor not found." });
        return;
      }

      sendJson(response, 200, { success: true, message: "Doctor updated successfully." });
      return;
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/doctors/")) {
      if (!sessionUser || sessionUser.role !== "admin") {
        sendJson(response, 403, { success: false, message: "Admin access required." });
        return;
      }

      const doctorId = Number(pathname.split("/").pop());
      if (!doctorId) {
        sendJson(response, 400, { success: false, message: "Invalid doctor ID." });
        return;
      }

      const doctor = await deleteDoctor(doctorId);
      if (!doctor) {
        sendJson(response, 404, { success: false, message: "Doctor not found." });
        return;
      }

      sendJson(response, 200, { success: true, message: "Doctor deleted successfully." });
      return;
    }

    if (request.method === "GET" && pathname === "/api/appointments") {
      if (!sessionUser) {
        sendJson(response, 401, { success: false, message: "Please log in first." });
        return;
      }

      if (sessionUser.role === "admin") {
        const appointments = await listAppointmentsForAdmin();
        sendJson(response, 200, { success: true, appointments });
        return;
      }

      const appointments = await listAppointmentsForPatient(sessionUser.id);
      sendJson(response, 200, { success: true, appointments });
      return;
    }

    if (request.method === "POST" && pathname === "/api/appointments") {
      if (!sessionUser || sessionUser.role !== "patient") {
        sendJson(response, 403, { success: false, message: "Patient access required." });
        return;
      }

      const body = await parseRequestBody(request);
      const validationError = validateAppointmentInput(body);

      if (validationError) {
        sendJson(response, 400, { success: false, message: validationError });
        return;
      }

      const doctor = await getDoctorById(Number(body.doctor_id));
      if (!doctor || doctor.is_active !== true) {
        sendJson(response, 404, { success: false, message: "Selected doctor is not available." });
        return;
      }

      const existingSlot = await findAppointmentSlot(body.doctor_id, body.appointment_date, body.appointment_time);
      if (existingSlot) {
        sendJson(response, 409, { success: false, message: "This doctor time slot is already booked." });
        return;
      }

      await createAppointment({
        user_id: sessionUser.id,
        doctor_id: body.doctor_id,
        appointment_date: body.appointment_date,
        appointment_time: body.appointment_time,
        reason: body.reason,
      });

      sendJson(response, 201, { success: true, message: "Appointment booked successfully." });
      return;
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/appointments/")) {
      if (!sessionUser) {
        sendJson(response, 401, { success: false, message: "Please log in first." });
        return;
      }

      const appointmentId = Number(pathname.split("/").pop());
      if (!appointmentId) {
        sendJson(response, 400, { success: false, message: "Invalid appointment ID." });
        return;
      }

      const appointment = await cancelAppointment(appointmentId, sessionUser);
      if (!appointment) {
        sendJson(response, 404, { success: false, message: "Appointment not found." });
        return;
      }

      sendJson(response, 200, { success: true, message: "Appointment cancelled successfully." });
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/stats") {
      if (!sessionUser || sessionUser.role !== "admin") {
        sendJson(response, 403, { success: false, message: "Admin access required." });
        return;
      }

      const stats = await getAdminStats();
      sendJson(response, 200, { success: true, stats });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { success: false, message: "API route not found." });
      return;
    }

    if (handleStaticRoutes(request, response, pathname)) {
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Page not found.");
  } catch (error) {
    console.error("Server error:", error.message);
    sendJson(response, 500, { success: false, message: error.message || "Internal server error." });
  }
});

server.listen(PORT, async () => {
  try {
    await ensureDynamoTables();
    await ensureSeedData();
    console.log(`Hospital Appointment Booking System is running at http://localhost:${PORT}`);
  } catch (error) {
    console.warn("DynamoDB table setup warning:", error.message);
    console.log(`Hospital Appointment Booking System is running at http://localhost:${PORT}`);
  }
});
