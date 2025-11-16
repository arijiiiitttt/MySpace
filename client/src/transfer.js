export async function uploadFile(file) {
    const form = new FormData();
    form.append("file", file);

    const res = await fetch("http://localhost:3000/upload", {
        method: "POST",
        body: form
    });

    return await res.json();
}
