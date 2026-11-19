//! Минимальный NBT (Java Edition, big-endian): чтение и запись без сжатия.
//! Нужен для servers.dat; level.dat (gzip) читается через flate2 + этот же парсер.

use std::io::{Read, Write};

use anyhow::{Result, bail};

#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<i8>),
    String(String),
    List(Vec<Tag>),
    Compound(Vec<(String, Tag)>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl Tag {
    fn id(&self) -> u8 {
        match self {
            Tag::Byte(_) => 1,
            Tag::Short(_) => 2,
            Tag::Int(_) => 3,
            Tag::Long(_) => 4,
            Tag::Float(_) => 5,
            Tag::Double(_) => 6,
            Tag::ByteArray(_) => 7,
            Tag::String(_) => 8,
            Tag::List(_) => 9,
            Tag::Compound(_) => 10,
            Tag::IntArray(_) => 11,
            Tag::LongArray(_) => 12,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Tag> {
        match self {
            Tag::Compound(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Tag::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Tag]> {
        match self {
            Tag::List(l) => Some(l),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Tag::Byte(v) => Some(*v as i64),
            Tag::Short(v) => Some(*v as i64),
            Tag::Int(v) => Some(*v as i64),
            Tag::Long(v) => Some(*v),
            _ => None,
        }
    }
}

struct Reader<R: Read> {
    r: R,
    depth: u32,
}

impl<R: Read> Reader<R> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut b = [0u8; N];
        self.r.read_exact(&mut b)?;
        Ok(b)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes::<1>()?[0])
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_be_bytes(self.bytes()?))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_be_bytes(self.bytes()?))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.bytes()?))
    }
    fn len(&mut self) -> Result<usize> {
        let n = self.i32()?;
        if !(0..=16 * 1024 * 1024).contains(&n) {
            bail!("Некорректная длина NBT: {n}");
        }
        Ok(n as usize)
    }
    fn string(&mut self) -> Result<String> {
        let len = u16::from_be_bytes(self.bytes()?) as usize;
        let mut buf = vec![0u8; len];
        self.r.read_exact(&mut buf)?;
        // Modified UTF-8 почти всегда совпадает с обычным для имён и адресов
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn payload(&mut self, id: u8) -> Result<Tag> {
        self.depth += 1;
        if self.depth > 256 {
            bail!("Слишком глубокий NBT");
        }
        let tag = match id {
            1 => Tag::Byte(self.u8()? as i8),
            2 => Tag::Short(self.i16()?),
            3 => Tag::Int(self.i32()?),
            4 => Tag::Long(self.i64()?),
            5 => Tag::Float(f32::from_be_bytes(self.bytes()?)),
            6 => Tag::Double(f64::from_be_bytes(self.bytes()?)),
            7 => {
                let n = self.len()?;
                let mut buf = vec![0u8; n];
                self.r.read_exact(&mut buf)?;
                Tag::ByteArray(buf.into_iter().map(|b| b as i8).collect())
            }
            8 => Tag::String(self.string()?),
            9 => {
                let item = self.u8()?;
                let n = self.len()?;
                let mut list = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    list.push(self.payload(item)?);
                }
                Tag::List(list)
            }
            10 => {
                let mut items = Vec::new();
                loop {
                    let child = self.u8()?;
                    if child == 0 {
                        break;
                    }
                    let name = self.string()?;
                    items.push((name, self.payload(child)?));
                }
                Tag::Compound(items)
            }
            11 => {
                let n = self.len()?;
                Tag::IntArray((0..n).map(|_| self.i32()).collect::<Result<_>>()?)
            }
            12 => {
                let n = self.len()?;
                Tag::LongArray((0..n).map(|_| self.i64()).collect::<Result<_>>()?)
            }
            other => bail!("Неизвестный тег NBT {other}"),
        };
        self.depth -= 1;
        Ok(tag)
    }
}

/// Прочитать корневой compound (без сжатия)
pub fn read(data: &[u8]) -> Result<Tag> {
    let mut r = Reader { r: data, depth: 0 };
    let id = r.u8()?;
    if id != 10 {
        bail!("Корень NBT — не compound");
    }
    let _name = r.string()?;
    r.payload(10)
}

/// Прочитать gzip-сжатый NBT (level.dat)
pub fn read_gzip(data: &[u8]) -> Result<Tag> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data).read_to_end(&mut out)?;
    read(&out)
}

fn write_string<W: Write>(w: &mut W, s: &str) -> Result<()> {
    let b = s.as_bytes();
    w.write_all(&(b.len().min(u16::MAX as usize) as u16).to_be_bytes())?;
    w.write_all(&b[..b.len().min(u16::MAX as usize)])?;
    Ok(())
}

fn write_payload<W: Write>(w: &mut W, tag: &Tag) -> Result<()> {
    match tag {
        Tag::Byte(v) => w.write_all(&[*v as u8])?,
        Tag::Short(v) => w.write_all(&v.to_be_bytes())?,
        Tag::Int(v) => w.write_all(&v.to_be_bytes())?,
        Tag::Long(v) => w.write_all(&v.to_be_bytes())?,
        Tag::Float(v) => w.write_all(&v.to_be_bytes())?,
        Tag::Double(v) => w.write_all(&v.to_be_bytes())?,
        Tag::ByteArray(v) => {
            w.write_all(&(v.len() as i32).to_be_bytes())?;
            w.write_all(&v.iter().map(|b| *b as u8).collect::<Vec<_>>())?;
        }
        Tag::String(s) => write_string(w, s)?,
        Tag::List(items) => {
            let id = items.first().map(Tag::id).unwrap_or(0);
            w.write_all(&[id])?;
            w.write_all(&(items.len() as i32).to_be_bytes())?;
            for item in items {
                write_payload(w, item)?;
            }
        }
        Tag::Compound(items) => {
            for (name, value) in items {
                w.write_all(&[value.id()])?;
                write_string(w, name)?;
                write_payload(w, value)?;
            }
            w.write_all(&[0])?;
        }
        Tag::IntArray(v) => {
            w.write_all(&(v.len() as i32).to_be_bytes())?;
            for x in v {
                w.write_all(&x.to_be_bytes())?;
            }
        }
        Tag::LongArray(v) => {
            w.write_all(&(v.len() as i32).to_be_bytes())?;
            for x in v {
                w.write_all(&x.to_be_bytes())?;
            }
        }
    }
    Ok(())
}

/// Записать корневой compound (без сжатия)
pub fn write(root: &Tag) -> Result<Vec<u8>> {
    let mut out = vec![10u8];
    write_string(&mut out, "")?;
    write_payload(&mut out, root)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let root = Tag::Compound(vec![(
            "servers".into(),
            Tag::List(vec![Tag::Compound(vec![
                ("name".into(), Tag::String("Мой сервер".into())),
                ("ip".into(), Tag::String("play.example.org".into())),
                ("hidden".into(), Tag::Byte(0)),
            ])]),
        )]);
        let bytes = write(&root).unwrap();
        let back = read(&bytes).unwrap();
        assert_eq!(back, root);
        let first = &back.get("servers").unwrap().as_list().unwrap()[0];
        assert_eq!(first.get("ip").unwrap().as_str(), Some("play.example.org"));
    }
}
